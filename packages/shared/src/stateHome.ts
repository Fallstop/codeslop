/**
 * Which directory a component treats as its state home.
 *
 * The rebrand moved the default from `~/.t3` to `~/.codeslop`, and each component
 * picked its own rule for machines that have both: the desktop app went straight
 * to the new name while the CLI, dev worktrees, and the SSH launcher kept
 * preferring the old one. On a machine carrying a pre-rebrand `~/.t3` that split
 * the same environment in two — the desktop serving one database, every
 * `t3 serve` serving another, with different environment ids.
 *
 * One rule, shared by all of them: whichever home already holds a database wins,
 * and the current name breaks the tie. That keeps a pre-rebrand install on its
 * live state without stranding an install that has already moved on.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export type JoinPath = (first: string, ...segments: string[]) => string;

/** Pre-rebrand name, used for both the user home and worktree-local state. */
export const LEGACY_STATE_HOME_DIR_NAME = ".t3";

/** Current name under the user's home directory. */
export const STATE_HOME_DIR_NAME = ".codeslop";

/** Current name for the state a linked git worktree keeps to itself. */
export const WORKTREE_STATE_HOME_DIR_NAME = ".slop";

/**
 * State directories a home may keep its database under: `userdata` normally,
 * `dev` when a dev server fronts it.
 */
export const STATE_HOME_DIR_NAMES = ["userdata", "dev"] as const;

const STATE_DATABASE_FILE_NAME = "state.sqlite";

/**
 * Paths that, if any exists, mean this home has been used. Probed rather than
 * testing for the directory itself, because an empty `~/.codeslop` gets created
 * as a side effect often enough that its presence proves nothing.
 */
export function stateHomeDatabaseCandidates(
  baseDir: string,
  join: JoinPath,
): ReadonlyArray<string> {
  return STATE_HOME_DIR_NAMES.map((stateDir) => join(baseDir, stateDir, STATE_DATABASE_FILE_NAME));
}

/** The two homes a user-level install may be using, current name first. */
export function userStateHomeCandidates(
  homeDirectory: string,
  join: JoinPath,
): { readonly current: string; readonly legacy: string } {
  return {
    current: join(homeDirectory, STATE_HOME_DIR_NAME),
    legacy: join(homeDirectory, LEGACY_STATE_HOME_DIR_NAME),
  };
}

/** The two homes a linked git worktree may be using, current name first. */
export function worktreeStateHomeCandidates(
  worktreePath: string,
  join: JoinPath,
): { readonly current: string; readonly legacy: string } {
  return {
    current: join(worktreePath, WORKTREE_STATE_HOME_DIR_NAME),
    legacy: join(worktreePath, LEGACY_STATE_HOME_DIR_NAME),
  };
}

/**
 * Pick between the current and pre-rebrand home. Callers supply the probes so
 * this stays pure and usable from Effect, plain Node, and Electron's pre-ready
 * startup path alike.
 */
export function preferInitializedStateHome(input: {
  readonly current: string;
  readonly legacy: string;
  readonly currentIsInitialized: boolean;
  readonly legacyIsInitialized: boolean;
}): string {
  if (input.currentIsInitialized) {
    return input.current;
  }
  return input.legacyIsInitialized ? input.legacy : input.current;
}

/** Whether this home already holds a database, so it is the one in use. */
export const stateHomeIsInitialized = Effect.fn("stateHome.isInitialized")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const found = yield* Effect.forEach(
    stateHomeDatabaseCandidates(baseDir, path.join),
    (candidate) => fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
    { concurrency: "unbounded" },
  );
  return found.some(Boolean);
});

/** Apply the shared rule to a pair of candidate homes. */
export const resolveStateHome = Effect.fn("stateHome.resolve")(function* (candidates: {
  readonly current: string;
  readonly legacy: string;
}) {
  return preferInitializedStateHome({
    ...candidates,
    currentIsInitialized: yield* stateHomeIsInitialized(candidates.current),
    legacyIsInitialized: yield* stateHomeIsInitialized(candidates.legacy),
  });
});

/** The state home a user-level install is using, by the shared rule. */
export const resolveUserStateHome = Effect.fn("stateHome.resolveUser")(function* (
  homeDirectory: string,
) {
  const path = yield* Path.Path;
  return yield* resolveStateHome(userStateHomeCandidates(homeDirectory, path.join));
});
