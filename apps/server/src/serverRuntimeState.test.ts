import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

// Above the default pid_max on Linux and macOS, so it can never name a live process.
const DEAD_PID = 4_194_305;

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("serverRuntimeState", () => {
  it.effect("finds a server that published beside its own ssh launch state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const runtimeStatePath = path.join(baseDir, "userdata", "server-runtime.json");
      const launched: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: process.pid,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-06-20T00:00:00.000Z",
      };
      const launchedPath = path.join(baseDir, "ssh-launch", "abc123", "server-runtime.json");
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: launchedPath,
        state: launched,
      });

      // The shared slot is empty, but the database is anything but idle: a CLI
      // that trusts the slot writes underneath the running server.
      assert.isTrue(
        Option.isNone(yield* ServerRuntimeState.readPersistedServerRuntimeState(runtimeStatePath)),
      );
      assert.deepEqual(
        Option.getOrThrow(
          yield* ServerRuntimeState.readLiveServerRuntimeState({ runtimeStatePath, baseDir }),
        ),
        launched,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the shared slot and ignores launches whose process is gone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const runtimeStatePath = path.join(baseDir, "userdata", "server-runtime.json");
      const base = {
        version: 1,
        pid: DEAD_PID,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-06-20T00:00:00.000Z",
      } satisfies ServerRuntimeState.PersistedServerRuntimeState;

      yield* ServerRuntimeState.persistServerRuntimeState({
        path: path.join(baseDir, "ssh-launch", "dead", "server-runtime.json"),
        state: base,
      });
      assert.isTrue(
        Option.isNone(
          yield* ServerRuntimeState.readLiveServerRuntimeState({ runtimeStatePath, baseDir }),
        ),
      );

      const desktop = { ...base, pid: process.pid, port: 3_774, origin: "http://127.0.0.1:3774" };
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: runtimeStatePath,
        state: desktop,
      });
      assert.deepEqual(
        Option.getOrThrow(
          yield* ServerRuntimeState.readLiveServerRuntimeState({ runtimeStatePath, baseDir }),
        ),
        desktop,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("has no live server when there are no launches at all", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      assert.isTrue(
        Option.isNone(
          yield* ServerRuntimeState.readLiveServerRuntimeState({
            runtimeStatePath: path.join(baseDir, "userdata", "server-runtime.json"),
            baseDir,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("clears the record only while it still describes the owner", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server-runtime.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 4_242,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-06-20T00:00:00.000Z",
      };
      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });

      // A co-located server shutting down must leave the incumbent's record alone.
      yield* ServerRuntimeState.clearOwnedServerRuntimeState({ path: statePath, ownerPid: 99 });
      assert.isTrue(
        Option.isSome(yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath)),
      );

      yield* ServerRuntimeState.clearOwnedServerRuntimeState({ path: statePath, ownerPid: 4_242 });
      assert.isTrue(
        Option.isNone(yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("clearing a stale record spares one whose process is alive", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server-runtime.json");
      const live: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: process.pid,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state: live });
      yield* ServerRuntimeState.clearStaleServerRuntimeState(statePath);
      assert.isTrue(
        Option.isSome(yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath)),
      );

      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...live, pid: DEAD_PID },
      });
      yield* ServerRuntimeState.clearStaleServerRuntimeState(statePath);
      assert.isTrue(
        Option.isNone(yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reasserts the record when it goes missing but not over a live server", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server-runtime.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: process.pid,
        port: 3_774,
        origin: "http://127.0.0.1:3774",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      // Missing: an older co-located server cleared a slot it did not own.
      assert.isTrue(
        yield* ServerRuntimeState.reassertServerRuntimeState({ path: statePath, state }),
      );
      assert.deepEqual(
        Option.getOrThrow(yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath)),
        state,
      );

      // Already ours: nothing to do.
      assert.isFalse(
        yield* ServerRuntimeState.reassertServerRuntimeState({ path: statePath, state }),
      );

      // Someone else, still running: leave it, they are reachable.
      const other = { ...state, pid: process.pid, port: 9_999, origin: "http://127.0.0.1:9999" };
      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state: other });
      assert.isFalse(
        yield* ServerRuntimeState.reassertServerRuntimeState({
          path: statePath,
          state: { ...state, pid: DEAD_PID },
        }),
      );

      // Someone else, gone: take the slot back.
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...other, pid: DEAD_PID },
      });
      assert.isTrue(
        yield* ServerRuntimeState.reassertServerRuntimeState({ path: statePath, state }),
      );
      assert.deepEqual(
        Option.getOrThrow(yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath)),
        state,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("marks a service-supervised server so CLIs can tell it from a manual one", () =>
    Effect.gen(function* () {
      const managed = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
        serviceManaged: true,
      });
      const manual = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });

      assert.isTrue(managed.serviceManaged);
      // Older readers decode the file without the field, so it is omitted
      // rather than written as false.
      assert.isFalse("serviceManaged" in manual);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
