const CHECKPOINT_REFS_PREFIX = "refs/slop/checkpoints";
/**
 * The pre-rebrand namespace. Checkpoint refs are rebuilt from thread and turn rather than read
 * back from stored events, so refs written before the rename are only reachable through this.
 */
const LEGACY_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

/** The same checkpoint ref under the pre-rebrand namespace, or null for refs outside it. */
export function legacyCheckpointRef(checkpointRef: string): string | null {
  return checkpointRef.startsWith(`${CHECKPOINT_REFS_PREFIX}/`)
    ? `${LEGACY_CHECKPOINT_REFS_PREFIX}${checkpointRef.slice(CHECKPOINT_REFS_PREFIX.length)}`
    : null;
}
