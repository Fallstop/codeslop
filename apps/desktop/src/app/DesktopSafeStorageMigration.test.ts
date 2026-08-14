import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSafeStorageMigration from "./DesktopSafeStorageMigration.ts";

const textEncoder = new TextEncoder();

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/codeslop.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/codeslop.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

const makeEnvironmentLayer = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  );
};

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | null;
}

interface ScriptedResponse {
  readonly exitCode: number;
  readonly stdout?: string;
}

const makeProcess = (response: ScriptedResponse): ChildProcessSpawner.ChildProcessHandle => {
  const output = response.stdout ?? "";
  const stdout = output.length === 0 ? Stream.empty : Stream.make(textEncoder.encode(output));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const collectStdin = (
  stdin: ChildProcess.CommandOptions["stdin"],
): Effect.Effect<string | null, PlatformError.PlatformError> =>
  stdin === undefined || typeof stdin === "string" || !Stream.isStream(stdin)
    ? Effect.succeed(null)
    : Stream.mkString(Stream.decodeText(stdin));

const makeSpawnerLayer = (input: {
  readonly calls: SpawnedCommand[];
  readonly respond: (call: SpawnedCommand) => ScriptedResponse;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") {
          return yield* Effect.die("unexpected pipe command");
        }
        const stdin = yield* collectStdin(command.options.stdin);
        const call: SpawnedCommand = { command: command.command, args: command.args, stdin };
        input.calls.push(call);
        return makeProcess(input.respond(call));
      }),
    ),
  );

const runMigration = (input: {
  readonly environment?: TestEnvironmentInput;
  readonly calls: SpawnedCommand[];
  readonly respond: (call: SpawnedCommand) => ScriptedResponse;
}) =>
  DesktopSafeStorageMigration.adoptLegacySafeStorageKey.pipe(
    Effect.provide(
      Layer.mergeAll(
        makeEnvironmentLayer(input.environment),
        makeSpawnerLayer({ calls: input.calls, respond: input.respond }),
      ),
    ),
  );

describe("DesktopSafeStorageMigration", () => {
  it.effect("leaves the keychain untouched when the codeslop key already exists", () =>
    Effect.gen(function* () {
      const calls: SpawnedCommand[] = [];

      yield* runMigration({
        calls,
        respond: () => ({ exitCode: 0 }),
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.command, "security");
      assert.deepEqual(calls[0]?.args, ["find-generic-password", "-s", "codeslop Safe Storage"]);
    }),
  );

  it.effect("copies the legacy t3code key into the codeslop item on first launch", () =>
    Effect.gen(function* () {
      const calls: SpawnedCommand[] = [];

      yield* runMigration({
        calls,
        respond: (call) => {
          if (call.args[0] === "find-generic-password" && call.args.includes("-w")) {
            return { exitCode: 0, stdout: "c2VjcmV0LWtleQ==\n" };
          }
          if (call.args[0] === "find-generic-password") {
            return { exitCode: 44 };
          }
          return { exitCode: 0 };
        },
      });

      assert.equal(calls.length, 3);
      assert.deepEqual(calls[1]?.args, [
        "find-generic-password",
        "-s",
        "t3code Safe Storage",
        "-w",
      ]);
      assert.equal(calls[2]?.command, "security");
      assert.deepEqual(calls[2]?.args, ["-i"]);
      assert.equal(
        calls[2]?.stdin,
        'add-generic-password -a "codeslop Key" -s "codeslop Safe Storage" -w "c2VjcmV0LWtleQ=="\n',
      );
    }),
  );

  it.effect("does nothing when no legacy key exists either", () =>
    Effect.gen(function* () {
      const calls: SpawnedCommand[] = [];

      yield* runMigration({
        calls,
        respond: () => ({ exitCode: 44 }),
      });

      assert.equal(calls.length, 2);
      assert.isTrue(calls.every((call) => call.args[0] === "find-generic-password"));
    }),
  );

  it.effect("uses the dev keychain item names in development", () =>
    Effect.gen(function* () {
      const calls: SpawnedCommand[] = [];

      yield* runMigration({
        environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
        calls,
        respond: (call) =>
          call.args[0] === "find-generic-password" && call.args.includes("-w")
            ? { exitCode: 0, stdout: "ZGV2LWtleQ==\n" }
            : call.args[0] === "find-generic-password"
              ? { exitCode: 44 }
              : { exitCode: 0 },
      });

      assert.deepEqual(calls[0]?.args, [
        "find-generic-password",
        "-s",
        "codeslop-dev Safe Storage",
      ]);
      assert.deepEqual(calls[1]?.args, [
        "find-generic-password",
        "-s",
        "t3code-dev Safe Storage",
        "-w",
      ]);
      assert.equal(
        calls[2]?.stdin,
        'add-generic-password -a "codeslop-dev Key" -s "codeslop-dev Safe Storage" -w "ZGV2LWtleQ=="\n',
      );
    }),
  );

  it.effect("copies the legacy libsecret item through secret-tool on linux", () =>
    Effect.gen(function* () {
      const calls: SpawnedCommand[] = [];

      yield* runMigration({
        environment: { platform: "linux" },
        calls,
        respond: (call) =>
          call.args[0] === "lookup" && call.args.includes("t3code")
            ? { exitCode: 0, stdout: "legacy-linux-key" }
            : call.args[0] === "lookup"
              ? { exitCode: 1 }
              : { exitCode: 0 },
      });

      assert.equal(calls.length, 3);
      assert.isTrue(calls.every((call) => call.command === "secret-tool"));
      assert.deepEqual(calls[0]?.args, [
        "lookup",
        "xdg:schema",
        "chrome_libsecret_os_crypt_password_v2",
        "application",
        "codeslop",
      ]);
      assert.deepEqual(calls[1]?.args, [
        "lookup",
        "xdg:schema",
        "chrome_libsecret_os_crypt_password_v2",
        "application",
        "t3code",
      ]);
      assert.deepEqual(calls[2]?.args, [
        "store",
        "--label",
        "codeslop Safe Storage",
        "xdg:schema",
        "chrome_libsecret_os_crypt_password_v2",
        "application",
        "codeslop",
      ]);
      assert.equal(calls[2]?.stdin, "legacy-linux-key");
    }),
  );

  it.effect("is a no-op on windows", () =>
    Effect.gen(function* () {
      const calls: SpawnedCommand[] = [];

      yield* runMigration({
        environment: { platform: "win32" },
        calls,
        respond: () => ({ exitCode: 0 }),
      });

      assert.equal(calls.length, 0);
    }),
  );

  it.effect("fails with a migration error when copying the key fails", () =>
    Effect.gen(function* () {
      const calls: SpawnedCommand[] = [];

      const error = yield* runMigration({
        calls,
        respond: (call) =>
          call.args[0] === "find-generic-password" && call.args.includes("-w")
            ? { exitCode: 0, stdout: "c2VjcmV0LWtleQ==\n" }
            : call.args[0] === "find-generic-password"
              ? { exitCode: 44 }
              : { exitCode: 1 },
      }).pipe(Effect.flip);

      assert.instanceOf(error, DesktopSafeStorageMigration.DesktopSafeStorageKeyMigrationError);
      assert.equal(error.operation, "copy-legacy-key");
      assert.equal(
        error.message,
        'Legacy safe-storage key migration failed during copy-legacy-key for "codeslop Safe Storage".',
      );
    }),
  );
});
