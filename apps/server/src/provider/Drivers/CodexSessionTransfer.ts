/**
 * CodexSessionTransfer — move a Codex conversation between machines.
 *
 * Codex resolves `thread/resume` by scanning `<CODEX_HOME>/sessions` for the
 * rollout file carrying the thread id, so a transplant is one file copy. It
 * needs no row in `state_N.sqlite` (that database is an index, not the source
 * of truth) and it does not care which date directory the file sits in.
 *
 * Verified against codex-cli 0.149.0: a home containing only `auth.json` and
 * one rollout resumed successfully from a different working directory, and
 * still resumed with the rollout deliberately filed under the wrong date. The
 * recorded `cwd` in `session_meta` and the origin paths inside `world_state`
 * are left untouched — resume takes the cwd from the caller and refreshes
 * environment state, so a resumed agent reports its real directory.
 *
 * @module provider/Drivers/CodexSessionTransfer
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SESSIONS_DIRECTORY = "sessions";

/** Rollout filenames end in the thread id, e.g. `rollout-<iso>-<threadId>.jsonl`. */
function isRolloutFor(fileName: string, threadId: string): boolean {
  return fileName.startsWith("rollout-") && fileName.endsWith(`-${threadId}.jsonl`);
}

/**
 * Find a thread's rollout by walking the sessions tree. Codex nests these under
 * `YYYY/MM/DD`, but nothing depends on that shape, so this walks rather than
 * computing a date path — the same reason install can pick any directory.
 */
export const findCodexRolloutPath = Effect.fn("CodexSessionTransfer.findCodexRolloutPath")(
  function* (input: { readonly codexHome: string; readonly threadId: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const walk = (directory: string): Effect.Effect<string | null, never, never> =>
      Effect.gen(function* () {
        const entries = yield* fileSystem
          .readDirectory(directory)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const entry of entries) {
          const entryPath = path.join(directory, entry);
          if (isRolloutFor(entry, input.threadId)) {
            return entryPath;
          }
          const info = yield* fileSystem.stat(entryPath).pipe(Effect.option);
          const isDirectory = info._tag === "Some" && info.value.type === "Directory";
          if (isDirectory) {
            const found = yield* walk(entryPath);
            if (found !== null) {
              return found;
            }
          }
        }
        return null;
      });

    return yield* walk(path.join(input.codexHome, SESSIONS_DIRECTORY));
  },
);

/**
 * Read a conversation's rollout for transport. Returns null when it cannot be
 * found, so the caller can refuse before stopping the user's session.
 */
export const exportCodexSession = Effect.fn("CodexSessionTransfer.exportCodexSession")(
  function* (input: { readonly codexHome: string; readonly threadId: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rolloutPath = yield* findCodexRolloutPath(input);
    if (rolloutPath === null) {
      return null;
    }
    const bytes = yield* fileSystem.readFile(rolloutPath);
    // The filename carries the thread id that resume matches on, so it travels
    // with the bytes rather than being recomputed on the far side.
    return { threadId: input.threadId, fileName: path.basename(rolloutPath), bytes };
  },
);

/**
 * Place a transported rollout in the target's sessions tree. The original
 * filename is preserved because resume matches on the id inside it; the
 * directory is the sessions root, since discovery walks the tree anyway.
 */
export const installCodexSession = Effect.fn("CodexSessionTransfer.installCodexSession")(
  function* (input: {
    readonly codexHome: string;
    readonly fileName: string;
    readonly bytes: Uint8Array;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(input.codexHome, SESSIONS_DIRECTORY);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const filePath = path.join(directory, input.fileName);
    yield* fileSystem.writeFile(filePath, input.bytes);
    return filePath;
  },
);
