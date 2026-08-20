import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Present when the server fronts a dev web server (VITE_DEV_SERVER_URL).
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedErrorClass<ServerRuntimeStateError>()(
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
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "host" | "devUrl">;
  readonly port: number;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
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
 * Signal 0 delivers nothing; it only reports whether the pid exists. EPERM means
 * it exists but belongs to another user, which still counts as alive.
 */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Put this server's record back when nothing else live is using the slot.
 *
 * Servers older than the compare-and-delete fix still clear the shared record on
 * their own shutdown, so a co-located one — an SSH-launched server on a remote
 * that has not been upgraded yet — can delete a live server's entry. Without
 * this, that server stays undiscoverable until it restarts, and every later
 * connection launches another server beside it.
 *
 * A record naming a different, still-running process is left alone: that server
 * is reachable and fighting over the slot would only produce churn.
 */
export const reassertServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  Effect.gen(function* () {
    const persisted = yield* readPersistedServerRuntimeState(input.path);
    if (Option.isSome(persisted)) {
      if (persisted.value.pid === input.state.pid) {
        return false;
      }
      if (processIsAlive(persisted.value.pid)) {
        return false;
      }
    }
    yield* persistServerRuntimeState({ path: input.path, state: input.state });
    return true;
  });

/**
 * Remove the record only while it still describes `ownerPid`.
 *
 * The path is a single slot per state directory, and a second server sharing the
 * directory (an SSH-launched one, say) would otherwise delete the incumbent's
 * record on its own shutdown — leaving a live server undiscoverable until it
 * restarts.
 */
/**
 * Find the server actually running against this state directory.
 *
 * A server launched over SSH publishes beside its own launch state rather than
 * into the shared slot, so the slot being empty does not mean the database is
 * idle. Callers that skip this end up treating a live environment as offline and
 * writing to its database behind its back.
 *
 * Mirrors `resolve_sibling_runtime_port` in the remote launch script; the two
 * must keep agreeing about where a launched server advertises itself.
 */
export const readLiveServerRuntimeState = (input: {
  readonly runtimeStatePath: string;
  readonly baseDir: string;
}) =>
  Effect.gen(function* () {
    const primary = yield* readPersistedServerRuntimeState(input.runtimeStatePath);
    if (Option.isSome(primary) && processIsAlive(primary.value.pid)) {
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
      if (Option.isSome(record) && processIsAlive(record.value.pid)) {
        return record;
      }
    }

    return Option.none<PersistedServerRuntimeState>();
  });

export const clearOwnedServerRuntimeState = (input: {
  readonly path: string;
  readonly ownerPid: number;
}) =>
  Effect.gen(function* () {
    const persisted = yield* readPersistedServerRuntimeState(input.path);
    if (Option.isNone(persisted) || persisted.value.pid !== input.ownerPid) {
      return;
    }
    yield* clearPersistedServerRuntimeState(input.path);
  });

/**
 * Clear a record left behind by a process that no longer exists. This is the only
 * clear a non-owner may perform: a live server's record stays put even when this
 * process cannot reach it, because an unreachable server is far more often a
 * transient failure than a dead one.
 */
export const clearStaleServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const persisted = yield* readPersistedServerRuntimeState(path);
    if (Option.isNone(persisted) || processIsAlive(persisted.value.pid)) {
      return;
    }
    yield* clearPersistedServerRuntimeState(path);
  });

export const clearPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
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

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
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
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
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
      Effect.map(Option.some),
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  }).pipe(
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
