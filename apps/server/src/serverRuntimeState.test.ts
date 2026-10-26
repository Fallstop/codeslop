import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { renderBootServicePlist, renderBootServiceUnit } from "./cloud/bootService.ts";
import { ServiceLauncherHostProcess } from "./cloud/serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "./cloud/serviceProtocol.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerRuntimeState from "./serverRuntimeState.ts";

// Above the default pid_max on Linux and macOS, so it can never name a live process.
const DEAD_PID = 4_194_305;

const startBesideBootService = Effect.fn("test.startBesideBootService")(function* (input: {
  readonly platform: "darwin" | "linux";
  readonly outputs: Readonly<Record<string, { readonly code: number; readonly stdout?: string }>>;
  readonly unitServesOtherHome?: boolean;
  readonly restartPending?: boolean;
  readonly activeVersion?: string;
  readonly npmRuntime?: boolean;
  readonly missingServiceState?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly connected?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-boot-service-" });
  const t3Home = path.join(root, ".t3");
  const serviceHome = input.unitServesOtherHome ? path.join(root, "other") : t3Home;
  for (const home of [t3Home, serviceHome]) {
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
  }
  yield* fs.makeDirectory(path.join(serviceHome, "runtime"));
  const activeVersion = input.activeVersion ?? "0.0.42";
  if (!input.missingServiceState) {
    yield* fs.writeFileString(
      path.join(serviceHome, "runtime", "service-state.json"),
      JSON.stringify({ protocol: input.npmRuntime ? 2 : 3, activeVersion }),
    );
  }
  if (input.npmRuntime) {
    const versionDir = path.join(serviceHome, "runtime", "versions", activeVersion);
    const entryPath = path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs");
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
  }

  if (input.restartPending) {
    yield* fs.writeFileString(
      path.join(serviceHome, "runtime", ".restart-pending"),
      `${activeVersion}\n`,
    );
  }
  const plan = {
    program: input.npmRuntime
      ? ["/usr/bin/node", path.join(serviceHome, "runtime", "service-launcher.mjs")]
      : [],
    baseDir: serviceHome,
    logPath: "",
    unitPath: "",
  };
  const [unitPath, unit] =
    input.platform === "darwin"
      ? [
          path.join(root, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
          renderBootServicePlist(plan, { homeDir: root, environmentPath: "" }),
        ]
      : [
          path.join(root, ".config", "systemd", "user", "t3code.service"),
          renderBootServiceUnit(plan),
        ];
  yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
  yield* fs.writeFileString(unitPath, unit);

  const probes: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (run) =>
      Effect.gen(function* () {
        const probe = `${path.basename(run.command)} ${run.args.find((arg) => !arg.startsWith("--"))}`;
        probes.push(probe);
        const output = input.outputs[probe];
        return yield* output === undefined
          ? Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: run.command,
                argumentCount: run.args.length,
                cause: new Error("not found"),
              }),
            )
          : Effect.succeed({
              stdout: output.stdout ?? "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(output.code),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
      }),
  });
  const result = yield* Effect.scoped(
    ServerOwnership.acquireServerOwnership(path.join(t3Home, "userdata", "server-runtime.json")),
  ).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcess.Platform, input.platform),
    Effect.provideService(HostProcess.UserId, 501),
    Effect.provideService(HostProcess.HomeDirectory, root),
    Effect.provideService(HostProcess.Environment, input.environment ?? {}),
    Effect.provideService(ServiceLauncherHostProcess, {
      connected: input.connected ?? false,
      send: () => false,
      on: () => undefined,
      off: () => undefined,
    }),
    Effect.result,
  );
  assert.includeMembers(
    ["launchctl print", "launchctl print-disabled", "systemctl is-active", "systemctl is-enabled"],
    probes,
  );
  return { result, t3Home };
});

describe("server ownership", () => {
  // An empty home, so no boot service unit installed on this machine is read.
  const layerOwnership = Layer.mergeAll(
    ProcessRunner.layer,
    Layer.effect(
      HostProcess.HomeDirectory,
      Effect.gen(function* () {
        return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      }),
    ),
    Layer.succeed(HostProcess.Environment, {}),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const makeState = ServerRuntimeState.makePersistedServerRuntimeState({
    config: { host: undefined, devUrl: undefined },
    port: 3773,
  });

  it.effect("lets only one of two racing starts own a state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-race-" });
      const statePath = path.join(root, "server-runtime.json");
      const attempts = yield* Effect.all(
        [
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter((result) => result._tag === "Success").length, 1);
      const refused = attempts.find((result) => result._tag === "Failure");
      assert.equal(refused?.failure._tag, "ServerAlreadyRunningError");
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("refuses a second owner without touching its record, then allows a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          const before = yield* fs.readFileString(statePath);
          const refused = yield* ServerOwnership.acquireServerOwnership(statePath).pipe(
            Effect.flip,
          );
          assert.equal(refused._tag, "ServerAlreadyRunningError");
          assert.equal(yield* fs.readFileString(statePath), before);
        }),
      );
      assert.isFalse(yield* fs.exists(statePath));
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("refuses beside a live pre-lock server and ignores a stale record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-legacy-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        // Any record time after this process started proves the PID was not reused.
        state: { ...state, startedAt: "2100-01-01T00:00:00.000Z" },
      });
      const refused = yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath)).pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "ServerAlreadyRunningError");
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...state, pid: 0 },
      });
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("never removes a runtime record another server published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-cleanup-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          yield* ServerRuntimeState.persistServerRuntimeState({
            path: statePath,
            state: { ...state, ownerId: "other-owner" },
          });
        }),
      );
      const remaining = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.equal(Option.getOrThrow(remaining).ownerId, "other-owner");
    }).pipe(Effect.provide(layerOwnership)),
  );

  describe("beside an installed boot service", () => {
    it.effect("refuses an old active or scheduled service even without its runtime record", () =>
      Effect.gen(function* () {
        for (const fixture of [
          {
            platform: "darwin",
            outputs: { "launchctl print": { code: 0 } },
          },
          {
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 113 },
              "launchctl print-disabled": {
                code: 0,
                stdout: '"com.t3tools.t3code.service" => false',
              },
            },
          },
          {
            platform: "linux",
            outputs: {
              // Restart= keeps an otherwise disabled service alive during its restart delay.
              "systemctl is-active": { code: 3, stdout: "activating\n" },
              "systemctl is-enabled": { code: 1, stdout: "disabled\n" },
            },
          },
          {
            platform: "linux",
            outputs: {
              "systemctl is-active": { code: 3, stdout: "inactive\n" },
              "systemctl is-enabled": { code: 0, stdout: "enabled\n" },
            },
          },
          {
            platform: "darwin",
            outputs: { "launchctl print": { code: 0 } },
            environment: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "{}" },
          },
        ] as const) {
          const { result, t3Home } = yield* startBesideBootService(fixture);
          assert.equal(result._tag, "Failure");
          if (result._tag !== "Failure") return;
          assert.equal(result.failure._tag, "OlderBootServiceError");
          assert.equal(Runtime.getErrorExitCode(result.failure), 78);
          assert.include(result.failure.message, t3Home);
          assert.include(result.failure.message, "slop update");
          assert.include(result.failure.message, "slop service restart");
          assert.include(result.failure.message, "No server was stopped");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "refuses an active npm-installed service with no standalone executable or runtime record",
      () =>
        Effect.gen(function* () {
          const { result } = yield* startBesideBootService({
            platform: "linux",
            activeVersion: "0.0.40",
            npmRuntime: true,
            outputs: {
              "systemctl is-active": { code: 0, stdout: "active\n" },
            },
          });
          assert.equal(result._tag, "Failure");
          if (result._tag !== "Failure") return;
          assert.equal(result.failure._tag, "OlderBootServiceError");
          assert.equal(Runtime.getErrorExitCode(result.failure), 78);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("refuses while the loaded service has not restarted into its lock-aware update", () =>
      Effect.gen(function* () {
        const { result } = yield* startBesideBootService({
          platform: "darwin",
          restartPending: true,
          activeVersion: "0.1.0",
          outputs: {
            "launchctl print": { code: 0 },
          },
        });
        assert.equal(result._tag === "Failure" && result.failure._tag, "OlderBootServiceError");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("allows lock-aware stable services that are loaded or stopped and enabled", () =>
      Effect.gen(function* () {
        for (const fixture of [
          {
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 0 },
            },
          },
          {
            platform: "linux",
            outputs: {
              "systemctl is-active": { code: 3, stdout: "inactive\n" },
              "systemctl is-enabled": { code: 0, stdout: "enabled\n" },
            },
          },
        ] as const) {
          const { result } = yield* startBesideBootService({ ...fixture, activeVersion: "0.1.0" });
          assert.equal(result._tag, "Success");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("allows services that cannot compete for this home", () =>
      Effect.gen(function* () {
        const outputs = {
          "launchctl print": { code: 0 },
        };
        for (const fixture of [
          { platform: "darwin", outputs, unitServesOtherHome: true },
          {
            platform: "darwin",
            outputs,
            environment: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "{}" },
            connected: true,
          },
          {
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 113 },
              "launchctl print-disabled": {
                code: 0,
                stdout: '"com.t3tools.t3code.service" => disabled',
              },
            },
          },
          {
            platform: "linux",
            outputs: {
              "systemctl is-active": { code: 3, stdout: "inactive\n" },
              "systemctl is-enabled": { code: 1, stdout: "disabled\n" },
            },
          },
        ] as const) {
          const { result } = yield* startBesideBootService(fixture);
          assert.equal(result._tag, "Success");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("allows startup when the service configuration or manager is unavailable", () =>
      Effect.gen(function* () {
        for (const fixture of [
          { outputs: {} },
          {
            outputs: {
              "launchctl print": { code: 113 },
              "launchctl print-disabled": { code: 1 },
            },
          },
          { outputs: { "launchctl print": { code: 0 } }, missingServiceState: true },
        ]) {
          const { result } = yield* startBesideBootService({ platform: "darwin", ...fixture });
          assert.equal(result._tag, "Success");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});

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
});
