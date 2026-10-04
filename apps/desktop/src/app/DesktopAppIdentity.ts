import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LEGACY_PROFILE_MARKER = "Preferences";

const AppPackageMetadata = Schema.Struct({
  t3codeCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  {
    readonly resolveUserDataPath: Effect.Effect<
      string,
      DesktopUserData.DesktopUserDataInitializationError
    >;
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
 * Resolves the Electron userData directory, keeping a pre-rebrand `t3code` profile in place.
 *
 * Runs before Electron is ready: `DesktopClerk` creates the Clerk bridge right after this, and
 * the bridge registers privileged schemes Electron rejects once `ready` fires. Startup provides
 * the synchronous `DesktopPreReadyFileSystem` so resolving never yields to the event loop.
 */
export const resolveUserDataPath = Effect.fn("desktop.appIdentity.resolveUserDataPath")(function* (
  environment: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    "appDataDirectory" | "userDataDirName" | "legacyUserDataDirName"
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacyPath = path.join(environment.appDataDirectory, environment.legacyUserDataDirName);
  // Chromium writes a bare `Local State` into the pre-`setPath` directory during early
  // startup, so probe `Preferences` to tell a real legacy profile from that stub.
  const marker = path.join(legacyPath, LEGACY_PROFILE_MARKER);
  const legacyProfileExists = yield* fileSystem
    .exists(marker)
    .pipe(
      Effect.mapError((cause) =>
        DesktopUserData.DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", marker),
      ),
    );
  return legacyProfileExists
    ? legacyPath
    : path.join(environment.appDataDirectory, environment.userDataDirName);
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const userDataContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
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

  const userDataPath = resolveUserDataPath(environment).pipe(Effect.provide(userDataContext));

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
