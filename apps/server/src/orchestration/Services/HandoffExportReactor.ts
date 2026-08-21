/**
 * HandoffExportReactor - freezes a thread and stages its handoff bundle.
 *
 * Reacts to `thread.handoff-started`: stop the provider session, read the
 * session bytes, publish the worktree, stage the bundle, and report the stage
 * back so every device watching the thread sees the same progress.
 *
 * @module HandoffExportReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface HandoffExportReactorShape {
  /**
   * Start reacting to thread.handoff-started domain events.
   *
   * Must be run in a scope so worker fibers are finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the export queue is empty and idle. Tests wait on this
   * rather than sleeping.
   */
  readonly drain: Effect.Effect<void>;
}

export class HandoffExportReactor extends Context.Service<
  HandoffExportReactor,
  HandoffExportReactorShape
>()("t3/orchestration/Services/HandoffExportReactor") {}
