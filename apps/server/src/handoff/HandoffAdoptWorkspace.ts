/**
 * HandoffAdoptWorkspace — recreate the origin's working tree on this machine.
 *
 * The origin published its whole worktree as a commit parented on HEAD. Here
 * we fetch that commit, check it out in a fresh worktree, and then reset the
 * index back to the base commit so everything the agent had uncommitted is
 * uncommitted again. Without that reset the far side would inherit the work as
 * a commit, which is not what the user left behind.
 *
 * Ignored files do not travel; the project's setup script rebuilds them.
 *
 * @module handoff/HandoffAdoptWorkspace
 */
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export interface PrepareHandoffWorktreeInput {
  /** An existing checkout of the same repository on this machine. */
  readonly repositoryPath: string;
  /** Where the adopted thread should live. */
  readonly worktreePath: string;
  /** Branch to create for the adopted work. */
  readonly branch: string;
  readonly remoteName: string;
  /** The ref the origin published, e.g. refs/heads/slop/handoff/<id>. */
  readonly handoffRef: string;
  /** Commit the origin's worktree was sitting on. */
  readonly baseCommit: string;
}

const OPERATION = "HandoffAdoptWorkspace.prepareHandoffWorktree";

/**
 * Fetch the published work and lay it out as a worktree whose uncommitted
 * changes match the origin's. Returns the worktree path.
 */
export const prepareHandoffWorktree = Effect.fn("HandoffAdoptWorkspace.prepareHandoffWorktree")(
  function* (input: PrepareHandoffWorktreeInput) {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      driver.execute({ operation: OPERATION, cwd, args });

    // Fetch into a local ref so the commit is reachable no matter how the
    // remote's default refspec is configured.
    const localRef = `refs/slop/adopted/${input.branch}`;
    yield* run(input.repositoryPath, [
      "fetch",
      input.remoteName,
      `+${input.handoffRef}:${localRef}`,
    ]);

    yield* run(input.repositoryPath, [
      "worktree",
      "add",
      "-b",
      input.branch,
      input.worktreePath,
      localRef,
    ]);

    // Move the branch back to the base commit while keeping the files: the
    // published tree becomes uncommitted work again, exactly as the agent had
    // it. --mixed also resets the index, so nothing arrives pre-staged.
    yield* run(input.worktreePath, ["reset", "--mixed", input.baseCommit]);

    return input.worktreePath;
  },
);
