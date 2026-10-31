/**
 * Claude Code finds a session at `<configDir>/projects/<slug(realpath(cwd))>/<id>.jsonl`,
 * so placing the transcript where the target's cwd hashes lets `--resume` continue it
 * (verified with claude 2.1.238). Per-record `cwd` values stay as-is; resume ignores them.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Longest slug Claude Code will use before it truncates and appends a hash. */
const MAX_SLUG_LENGTH = 200;

/**
 * Claude Code's own path hash: a 32-bit `h * 31 + c` accumulator rendered in
 * base 36. Computed over the ORIGINAL path, not the substituted slug.
 */
function pathHash(absolutePath: string): string {
  let hash = 0;
  for (let index = 0; index < absolutePath.length; index += 1) {
    hash = ((hash << 5) - hash + absolutePath.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Directory name Claude Code files a working directory's sessions under. Pass
 * a real, resolved path: on macOS `/tmp/x` and `/private/tmp/x` produce
 * different slugs, and only the resolved one is where the CLI looks.
 */
export function claudeProjectSlug(absolutePath: string): string {
  const substituted = absolutePath.replace(/[^a-zA-Z0-9]/g, "-");
  if (substituted.length <= MAX_SLUG_LENGTH) {
    return substituted;
  }
  return `${substituted.slice(0, MAX_SLUG_LENGTH)}-${pathHash(absolutePath)}`;
}

/**
 * Resolve a working directory the way Claude Code does before slugging it:
 * follow symlinks, and fall back to the path as given when it does not exist
 * yet (the CLI does the same).
 */
const resolveSlugPath = Effect.fn("ClaudeSessionTransfer.resolveSlugPath")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(cwd);
  return yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
});

const claudeSessionFilePath = Effect.fn("ClaudeSessionTransfer.claudeSessionFilePath")(
  function* (input: {
    readonly configDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }) {
    const path = yield* Path.Path;
    const slugPath = yield* resolveSlugPath(input.cwd);
    return path.join(
      input.configDir,
      "projects",
      claudeProjectSlug(slugPath),
      `${input.sessionId}.jsonl`,
    );
  },
);

/** Whether the session's transcript is on disk, so the CLI must resume it rather than create it. */
export const claudeSessionExists = Effect.fn("ClaudeSessionTransfer.claudeSessionExists")(
  function* (input: {
    readonly configDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const filePath = yield* claudeSessionFilePath(input);
    return yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  },
);

/**
 * Read a session's transcript for transport. Returns null when the file is
 * missing so a caller can refuse the handoff before stopping the user's
 * session rather than after.
 */
export const exportClaudeSession = Effect.fn("ClaudeSessionTransfer.exportClaudeSession")(
  function* (input: {
    readonly configDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const filePath = yield* claudeSessionFilePath(input);
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }
    const bytes = yield* fileSystem.readFile(filePath);
    return { sessionId: input.sessionId, bytes };
  },
);

/**
 * Place a transported transcript where the target's cwd will find it.
 *
 * The trailing newline matters: Claude Code appends to this file, and without
 * it the next record is concatenated onto the last line and the transcript
 * stops parsing.
 */
export const installClaudeSession = Effect.fn("ClaudeSessionTransfer.installClaudeSession")(
  function* (input: {
    readonly configDir: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly bytes: Uint8Array;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = yield* claudeSessionFilePath(input);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    const needsNewline = input.bytes.length > 0 && input.bytes[input.bytes.length - 1] !== 0x0a;
    const bytes = needsNewline ? Uint8Array.from([...input.bytes, 0x0a]) : input.bytes;
    yield* fileSystem.writeFile(filePath, bytes);
    return filePath;
  },
);
