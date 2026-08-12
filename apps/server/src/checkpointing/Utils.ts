import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/slop/checkpoints";
/**
 * The pre-rebrand namespace. Checkpoint refs are rebuilt from thread and turn rather than read
 * back from stored events, so refs written before the rename are only reachable through this.
 */
export const LEGACY_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/** The same checkpoint ref under the pre-rebrand namespace, or null for refs outside it. */
export function legacyCheckpointRef(checkpointRef: string): string | null {
  return checkpointRef.startsWith(`${CHECKPOINT_REFS_PREFIX}/`)
    ? `${LEGACY_CHECKPOINT_REFS_PREFIX}${checkpointRef.slice(CHECKPOINT_REFS_PREFIX.length)}`
    : null;
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
