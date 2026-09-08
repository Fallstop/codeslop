import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// Electron safeStorage derives its encryption key from an OS-keyring item
// whose name follows the app's name: pre-rebrand installs hold the key in
// "t3code Safe Storage" (dev: "t3code-dev Safe Storage"), while the rebranded
// app looks up "codeslop Safe Storage" and would otherwise mint a fresh key on
// first launch — leaving every catalog encrypted under the legacy key
// undecryptable. Mirroring the legacy userData-dir adoption in
// DesktopAppIdentity, this module copies the legacy key under the new item
// name before anything can decrypt (or lazily create) it.

const textEncoder = new TextEncoder();

const CHROME_LIBSECRET_SCHEMA = "chrome_libsecret_os_crypt_password_v2";

const DesktopSafeStorageKeyMigrationOperation = Schema.Literals([
  "probe-current-key",
  "read-legacy-key",
  "copy-legacy-key",
]);

export class DesktopSafeStorageKeyMigrationError extends Schema.TaggedError<DesktopSafeStorageKeyMigrationError>()(
  "DesktopSafeStorageKeyMigrationError",
  {
    operation: DesktopSafeStorageKeyMigrationOperation,
    serviceName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Legacy safe-storage key migration failed during ${this.operation} for "${this.serviceName}".`;
  }
}

export interface SafeStorageKeychainItems {
  readonly currentService: string;
  readonly legacyService: string;
  /** macOS keychain account — Chromium's os_crypt uses "<app name> Key". */
  readonly currentAccount: string;
  /** Linux libsecret "application" attribute values — the bare app names. */
  readonly currentApplication: string;
  readonly legacyApplication: string;
}

export const resolveSafeStorageKeychainItems = (environment: {
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
}): SafeStorageKeychainItems => ({
  currentService: `${environment.userDataDirName} Safe Storage`,
  legacyService: `${environment.legacyUserDataDirName} Safe Storage`,
  currentAccount: `${environment.userDataDirName} Key`,
  currentApplication: environment.userDataDirName,
  legacyApplication: environment.legacyUserDataDirName,
});

const commandDefaults = {
  stdout: "pipe",
  stderr: "ignore",
} as const;

const runCollected = (
  command: ChildProcess.Command,
): Effect.Effect<
  { readonly stdout: string; readonly exitCode: number },
  Error,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(command);
      const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
      const exitCode = yield* handle.exitCode;
      return { stdout, exitCode };
    }),
  );

const migrationError =
  (operation: typeof DesktopSafeStorageKeyMigrationOperation.Type, serviceName: string) =>
  (cause: unknown) =>
    new DesktopSafeStorageKeyMigrationError({ operation, serviceName, cause });

// `security`'s interactive parser understands double-quoted strings with
// backslash escapes; the key is base64 but escape defensively anyway.
const quoteSecurityValue = (value: string): string => `"${value.replace(/([\\"])/g, "\\$1")}"`;

const stripTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

const adoptDarwinKeychainItem = Effect.fn("desktop.safeStorageMigration.adoptDarwin")(function* (
  items: SafeStorageKeychainItems,
): Effect.fn.Return<
  void,
  DesktopSafeStorageKeyMigrationError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const currentProbe = yield* spawner
    .exitCode(
      ChildProcess.make("security", ["find-generic-password", "-s", items.currentService], {
        ...commandDefaults,
        stdout: "ignore",
      }),
    )
    .pipe(Effect.mapError(migrationError("probe-current-key", items.currentService)));
  if (currentProbe === 0) {
    return;
  }

  const legacy = yield* runCollected(
    ChildProcess.make(
      "security",
      ["find-generic-password", "-s", items.legacyService, "-w"],
      commandDefaults,
    ),
  ).pipe(Effect.mapError(migrationError("read-legacy-key", items.legacyService)));
  const password = stripTrailingNewline(legacy.stdout);
  if (legacy.exitCode !== 0 || password.length === 0) {
    return;
  }

  // Pass the key over stdin via `security -i` so it never appears in argv.
  // The account must be the "<app name> Key" Chromium convention — lookups
  // match on service AND account, so a mismatch reads as "no key" and
  // Electron mints a fresh one anyway.
  const copyScript = [
    "add-generic-password",
    `-a ${quoteSecurityValue(items.currentAccount)}`,
    `-s ${quoteSecurityValue(items.currentService)}`,
    `-w ${quoteSecurityValue(password)}`,
  ].join(" ");
  const copyExitCode = yield* spawner
    .exitCode(
      ChildProcess.make("security", ["-i"], {
        ...commandDefaults,
        stdout: "ignore",
        stdin: Stream.make(textEncoder.encode(`${copyScript}\n`)),
      }),
    )
    .pipe(Effect.mapError(migrationError("copy-legacy-key", items.currentService)));
  if (copyExitCode !== 0) {
    return yield* new DesktopSafeStorageKeyMigrationError({
      operation: "copy-legacy-key",
      serviceName: items.currentService,
      cause: new Error(`security -i exited with code ${copyExitCode}.`),
    });
  }

  yield* Effect.logInfo("Adopted the legacy safe-storage key.", {
    legacyService: items.legacyService,
    currentService: items.currentService,
  });
});

const libsecretLookupCommand = (application: string): ChildProcess.Command =>
  ChildProcess.make(
    "secret-tool",
    ["lookup", "xdg:schema", CHROME_LIBSECRET_SCHEMA, "application", application],
    commandDefaults,
  );

const adoptLinuxKeyringItem = Effect.fn("desktop.safeStorageMigration.adoptLinux")(function* (
  items: SafeStorageKeychainItems,
): Effect.fn.Return<
  void,
  DesktopSafeStorageKeyMigrationError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const currentProbe = yield* runCollected(libsecretLookupCommand(items.currentApplication)).pipe(
    Effect.mapError(migrationError("probe-current-key", items.currentService)),
  );
  if (currentProbe.exitCode === 0 && stripTrailingNewline(currentProbe.stdout).length > 0) {
    return;
  }

  const legacy = yield* runCollected(libsecretLookupCommand(items.legacyApplication)).pipe(
    Effect.mapError(migrationError("read-legacy-key", items.legacyService)),
  );
  const password = stripTrailingNewline(legacy.stdout);
  if (legacy.exitCode !== 0 || password.length === 0) {
    return;
  }

  const storeExitCode = yield* spawner
    .exitCode(
      ChildProcess.make(
        "secret-tool",
        [
          "store",
          "--label",
          items.currentService,
          "xdg:schema",
          CHROME_LIBSECRET_SCHEMA,
          "application",
          items.currentApplication,
        ],
        {
          ...commandDefaults,
          stdout: "ignore",
          stdin: Stream.make(textEncoder.encode(password)),
        },
      ),
    )
    .pipe(Effect.mapError(migrationError("copy-legacy-key", items.currentService)));
  if (storeExitCode !== 0) {
    return yield* new DesktopSafeStorageKeyMigrationError({
      operation: "copy-legacy-key",
      serviceName: items.currentService,
      cause: new Error(`secret-tool store exited with code ${storeExitCode}.`),
    });
  }

  yield* Effect.logInfo("Adopted the legacy safe-storage key.", {
    legacyService: items.legacyService,
    currentService: items.currentService,
  });
});

// Windows safeStorage keys live in DPAPI and are not scoped to the app name,
// so only darwin and linux need adoption.
export const adoptLegacySafeStorageKey: Effect.Effect<
  void,
  DesktopSafeStorageKeyMigrationError,
  DesktopEnvironment.DesktopEnvironment | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const items = resolveSafeStorageKeychainItems(environment);
  if (environment.platform === "darwin") {
    return yield* adoptDarwinKeychainItem(items);
  }
  if (environment.platform === "linux") {
    return yield* adoptLinuxKeyringItem(items);
  }
}).pipe(Effect.withSpan("desktop.safeStorageMigration.adoptLegacySafeStorageKey"));
