import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

const WINDOWS_ABSOLUTE_PATH_REGEX = /^(?:[a-z]:[\\/]|\\\\)/i;

/**
 * Whether a dropped host path names a file on the environment running the turn: a Windows
 * path handed to a WSL backend points at nothing. Unknown platforms are trusted, since callers
 * only resolve paths for this machine's own backend.
 */
export function isPathUsableOnPlatform(
  path: string,
  os: ExecutionEnvironmentPlatformOs | null,
): boolean {
  switch (os) {
    case "windows":
      return WINDOWS_ABSOLUTE_PATH_REGEX.test(path);
    case "darwin":
    case "linux":
      return path.startsWith("/");
    default:
      return WINDOWS_ABSOLUTE_PATH_REGEX.test(path) || path.startsWith("/");
  }
}

export interface DroppedComposerFiles {
  /** Image files, which are attached and sent with the turn. */
  readonly imageFiles: File[];
  /** Markdown links to non-image files the environment can open on disk. */
  readonly fileLinks: string[];
  /** Non-image files with no usable path, which cannot be attached or linked. */
  readonly unlinkableFiles: File[];
}

/**
 * Split an OS file drop into the three things the composer can do with it.
 * `resolvePath` is null wherever a real path is unavailable — every browser,
 * and any environment that does not share this machine's filesystem — which
 * leaves non-image files unlinkable and reported as unsupported.
 */
export function partitionDroppedComposerFiles(input: {
  readonly files: readonly File[];
  readonly resolvePath: ((file: File) => string | null) | null;
  readonly environmentOs: ExecutionEnvironmentPlatformOs | null;
}): DroppedComposerFiles {
  const imageFiles: File[] = [];
  const fileLinks: string[] = [];
  const unlinkableFiles: File[] = [];

  for (const file of input.files) {
    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
      continue;
    }
    const path = input.resolvePath?.(file) ?? null;
    if (path === null || !isPathUsableOnPlatform(path, input.environmentOs)) {
      unlinkableFiles.push(file);
      continue;
    }
    fileLinks.push(serializeComposerFileLink(path));
  }

  return { imageFiles, fileLinks, unlinkableFiles };
}

/**
 * On-disk path of a dropped file, or null off the desktop app: a browser never
 * exposes one, and older desktop builds lack the bridge method.
 */
export function readDesktopDroppedFilePath(file: File): string | null {
  return window.desktopBridge?.getPathForFile?.(file) ?? null;
}
