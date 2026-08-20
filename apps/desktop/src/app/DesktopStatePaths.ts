import {
  preferInitializedStateHome,
  stateHomeDatabaseCandidates,
  userStateHomeCandidates,
} from "@t3tools/shared/stateHome";
import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

/**
 * `fileExists` is injected because this also runs before Electron is ready, where
 * the app's own filesystem services are not available yet.
 */
export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly fileExists: (path: string) => boolean;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () => {
    const { current, legacy } = userStateHomeCandidates(input.homeDirectory, input.joinPath);
    const isInitialized = (baseDir: string) =>
      stateHomeDatabaseCandidates(baseDir, input.joinPath).some(input.fileExists);
    return preferInitializedStateHome({
      current,
      legacy,
      currentIsInitialized: isInitialized(current),
      legacyIsInitialized: isInitialized(legacy),
    });
  });
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
