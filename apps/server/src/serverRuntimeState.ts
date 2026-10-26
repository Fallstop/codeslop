import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import packageJson from "../package.json" with { type: "json" };
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  privateNetworkOnly: Schema.optional(Schema.Boolean),
  port: Schema.Int,
  origin: Schema.String,
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedError<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

/** Where the SSH launcher keeps per-launch state, including a launched server's record. */
const SSH_LAUNCH_DIR_NAME = "ssh-launch";
const SERVER_RUNTIME_FILE_NAME = "server-runtime.json";

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<
    ServerConfig.ServerConfig["Service"],
    "host" | "privateNetworkOnly" | "devUrl"
  >;
  readonly port: number;
  readonly serviceManaged?: boolean;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    ...(input.config.privateNetworkOnly ? { privateNetworkOnly: true } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
    ...(input.serviceManaged ? { serviceManaged: true } : {}),
    serverVersion: packageJson.version,
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

/**
 * Put this server's record back when nothing else live holds the slot: servers
 * predating compare-and-delete still clear a record they do not own on shutdown.
 * A different, still-running owner is left alone; it is reachable.
 */
export const reassertServerRuntimeState = Effect.fn(
  "serverRuntimeState.reassertServerRuntimeState",
)(function* (input: { readonly path: string; readonly state: PersistedServerRuntimeState }) {
  const persisted = yield* readPersistedServerRuntimeState(input.path);
  if (Option.isSome(persisted)) {
    if (persisted.value.pid === input.state.pid) {
      return false;
    }
    if (isProcessAlive(persisted.value.pid)) {
      return false;
    }
  }
  yield* persistServerRuntimeState({ path: input.path, state: input.state });
  return true;
});

/**
 * The server actually running against this state directory. An SSH-launched one
 * publishes beside its launch state, so an empty shared slot does not mean the
 * database is idle. Mirrors `resolve_sibling_runtime_port` in the remote launch script.
 */
export const readLiveServerRuntimeState = Effect.fn(
  "serverRuntimeState.readLiveServerRuntimeState",
)(function* (input: { readonly runtimeStatePath: string; readonly baseDir: string }) {
  const primary = yield* readPersistedServerRuntimeState(input.runtimeStatePath);
  if (Option.isSome(primary) && isProcessAlive(primary.value.pid)) {
    return primary;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sshLaunchDir = path.join(input.baseDir, SSH_LAUNCH_DIR_NAME);
  const stateKeys = yield* fileSystem
    .readDirectory(sshLaunchDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  for (const stateKey of stateKeys) {
    const candidate = path.join(sshLaunchDir, stateKey, SERVER_RUNTIME_FILE_NAME);
    if (candidate === input.runtimeStatePath) {
      continue;
    }
    const record = yield* readPersistedServerRuntimeState(candidate);
    if (Option.isSome(record) && isProcessAlive(record.value.pid)) {
      return record;
    }
  }

  return Option.none<PersistedServerRuntimeState>();
});

/**
 * Clear a record whose process is gone; the only clear a non-owner may do. An
 * unreachable live server is far more often a transient failure than a dead one.
 */
export const clearStaleServerRuntimeState = Effect.fn(
  "serverRuntimeState.clearStaleServerRuntimeState",
)(function* (path: string) {
  const persisted = yield* readPersistedServerRuntimeState(path);
  if (Option.isNone(persisted) || isProcessAlive(persisted.value.pid)) {
    return;
  }
  yield* clearPersistedServerRuntimeState(path);
});

export const clearPersistedServerRuntimeState = Effect.fn(
  "serverRuntimeState.clearPersistedServerRuntimeState",
)(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, { force: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "clear",
          statePath: path,
          cause,
        }),
    ),
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
        ),
    }),
  );
});

/** Signal 0 only probes existence; EPERM still means alive. */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const readPersistedServerRuntimeState = Effect.fn(
  "serverRuntimeState.readPersistedServerRuntimeState",
)(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeedSome(contents),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.asSome,
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  },
  Effect.catchTags({
    ServerRuntimeStateError: (error) =>
      Effect.logWarning(error.message).pipe(
        Effect.annotateLogs({
          operation: error.operation,
          statePath: error.statePath,
          cause: error,
        }),
        Effect.as(Option.none<PersistedServerRuntimeState>()),
      ),
  }),
);
