// @effect-diagnostics nodeBuiltinImport:off - the legacy-profile probe must stay synchronous; see resolveUserDataPath.
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LEGACY_PROFILE_MARKER = "Preferences";

const AppPackageMetadata = Schema.Struct({
  t3codeCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

export class DesktopUserDataPathResolutionError extends Schema.TaggedErrorClass<DesktopUserDataPathResolutionError>()(
  "DesktopUserDataPathResolutionError",
  {
    legacyPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to inspect legacy desktop user-data path at "${this.legacyPath}".`;
  }
}

export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  {
    readonly resolveUserDataPath: Effect.Effect<string, DesktopUserDataPathResolutionError>;
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppIdentity") {}

const normalizeCommitHash = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return COMMIT_HASH_PATTERN.test(trimmed)
    ? Option.some(trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase())
    : Option.none();
};

/**
 * Probes the legacy profile marker without yielding the event loop. `statSync` rather than
 * `existsSync` so an unreadable legacy directory raises instead of reading as "missing" —
 * silently adopting the new path there would orphan the profile this probe exists to find.
 */
const legacyProfileExistsSync = (path: string): boolean =>
  NodeFS.statSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * Resolves the Electron userData directory, given a synchronous existence probe.
 *
 * The probe must stay synchronous. `DesktopClerk` creates the Clerk bridge immediately after
 * this resolves, and the bridge registers privileged schemes, which Electron rejects once
 * `ready` has fired. Awaiting here hands the event loop back and lets `ready` win the race,
 * failing startup with `protocol.registerSchemesAsPrivileged should be called before app is
 * ready`. `fileExists` is injected rather than taken from the app's FileSystem service because
 * that service is async, and this runs before Electron is ready.
 */
export const makeResolveUserDataPath = Effect.fn("desktop.appIdentity.resolveUserDataPath")(
  function* (fileExists: (path: string) => boolean) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const legacyPath = environment.path.join(
      environment.appDataDirectory,
      environment.legacyUserDataDirName,
    );
    // Chromium writes a bare `Local State` into the pre-`setPath` directory during early
    // startup, so a legacy directory can exist while holding no profile at all. Probing for
    // `Preferences` distinguishes a real pre-rebrand profile from that stub — adopting the
    // stub would silently orphan the current profile.
    const legacyProfileExists = yield* Effect.try({
      try: () => fileExists(environment.path.join(legacyPath, LEGACY_PROFILE_MARKER)),
      catch: (cause) =>
        new DesktopUserDataPathResolutionError({
          legacyPath,
          cause,
        }),
    });
    return legacyProfileExists
      ? legacyPath
      : environment.path.join(environment.appDataDirectory, environment.userDataDirName);
  },
);

export const resolveUserDataPath = makeResolveUserDataPath(legacyProfileExistsSync);
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const commitHashCache = yield* Ref.make<Option.Option<Option.Option<string>>>(Option.none());

  const resolveEmbeddedCommitHash = Effect.gen(function* () {
    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (value) =>
        decodeAppPackageMetadata(value).pipe(
          Effect.map((parsed) =>
            Option.fromNullishOr(parsed.t3codeCommitHash).pipe(Option.flatMap(normalizeCommitHash)),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });
  });

  const resolveAboutCommitHash = Effect.gen(function* () {
    const cached = yield* Ref.get(commitHashCache);
    if (Option.isSome(cached)) {
      return cached.value;
    }

    const override = Option.flatMap(environment.commitHashOverride, normalizeCommitHash);
    if (Option.isSome(override)) {
      yield* Ref.set(commitHashCache, Option.some(override));
      return override;
    }

    if (!environment.isPackaged) {
      const empty = Option.none<string>();
      yield* Ref.set(commitHashCache, Option.some(empty));
      return empty;
    }

    const commitHash = yield* resolveEmbeddedCommitHash;
    yield* Ref.set(commitHashCache, Option.some(commitHash));
    return commitHash;
  });

  const userDataPath = resolveUserDataPath.pipe(
    Effect.provide(yield* Effect.context<DesktopEnvironment.DesktopEnvironment>()),
  );

  const configure = Effect.gen(function* () {
    const commitHash = yield* resolveAboutCommitHash;
    yield* electronApp.setName(environment.displayName);
    yield* electronApp.setAboutPanelOptions({
      applicationName: environment.displayName,
      applicationVersion: environment.appVersion,
      version: Option.getOrElse(commitHash, () => "unknown"),
    });

    if (environment.platform === "win32") {
      yield* electronApp.setAppUserModelId(environment.appUserModelId);
    }

    if (environment.platform === "linux") {
      yield* electronApp.setDesktopName(environment.linuxDesktopEntryName);
    }

    // Unpackaged runs only. A packaged bundle already carries its icon in
    // Info.plist, so setting the dock tile again changes nothing except to
    // overwrite a custom icon the user attached to the app themselves.
    if (environment.platform === "darwin" && !environment.isPackaged) {
      const iconPaths = yield* assets.iconPaths;
      yield* Option.match(iconPaths.png, {
        onNone: () => Effect.void,
        onSome: electronApp.setDockIcon,
      });
    }
  }).pipe(Effect.withSpan("desktop.appIdentity.configure"));

  return DesktopAppIdentity.of({
    resolveUserDataPath: userDataPath,
    configure,
  });
});

export const layer = Layer.effect(DesktopAppIdentity, make);
