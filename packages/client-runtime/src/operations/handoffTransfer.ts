/**
 * Handoff transfer — everything that happens once a bundle is staged.
 *
 * The origin freezes and stages on its own, driven by a reactor. From there
 * the client is the only thing that can see both machines, so it carries the
 * bytes, has the target adopt them, creates the thread that continues the work,
 * and finally marks the origin done.
 *
 * Order is deliberate and load-bearing:
 *   adopt (checks out the work, installs the session)
 *   -> create the target thread on the worktree adopt just made
 *   -> send the continuation turn
 *   -> mark the origin handed off
 * Nothing marks the origin until the work is genuinely running elsewhere, so a
 * failure anywhere leaves a thread the user can retry, cancel, or take back —
 * never one that claims to be somewhere it is not.
 *
 * @module operations/handoffTransfer
 */
import type { HandoffId, ThreadId, ThreadHandoffStage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { courierHandoffBundle, type HandoffCourierPorts } from "./handoff.ts";

export interface HandoffTransferPorts<E> extends Omit<HandoffCourierPorts<E>, "completeHandoff"> {
  /**
   * Create the thread that continues the work, on the worktree adopt produced.
   * Carries `continuedFrom` so the two threads are linked from birth rather
   * than by a follow-up write that could be lost.
   */
  readonly createContinuationThread: (input: {
    readonly threadId: ThreadId;
    readonly worktreePath: string;
  }) => Effect.Effect<unknown, E>;
  /** Send the first turn on the target so the agent picks the work back up. */
  readonly startContinuationTurn: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<unknown, E>;
  /** Stamp the origin with where the work went. */
  readonly completeHandoff: (input: {
    readonly adoptedSessionId: string;
  }) => Effect.Effect<unknown, E>;
  /** Park the handoff with a reason the banner can show. */
  readonly reportFailure: (input: {
    readonly stage: ThreadHandoffStage;
    readonly error: string;
  }) => Effect.Effect<unknown, E>;
}

export interface RunHandoffTransferInput<E> {
  readonly handoffId: HandoffId;
  /** The id minted when the handoff started; both ends already share it. */
  readonly targetThreadId: ThreadId;
  readonly repositoryPath: string;
  readonly worktreePath: string | null;
  readonly branch: string;
  /** Sent as the continuation turn, if the user typed one. */
  readonly ports: HandoffTransferPorts<E>;
  readonly startImmediately: boolean;
  readonly chunkBytes?: number;
}

/**
 * Carry a staged bundle across and bring the thread up on the other machine.
 *
 * Failures are reported to the origin rather than swallowed: the thread is
 * already stopped by this point, so silence would leave the user staring at a
 * frozen thread with no explanation.
 */
export const runHandoffTransfer = Effect.fn("handoff.runHandoffTransfer")(function* <E>(
  input: RunHandoffTransferInput<E>,
) {
  const ports = input.ports;

  const transferred = yield* courierHandoffBundle({
    handoffId: input.handoffId,
    repositoryPath: input.repositoryPath,
    worktreePath: input.worktreePath,
    branch: input.branch,
    ...(input.chunkBytes !== undefined ? { chunkBytes: input.chunkBytes } : {}),
    ports: {
      ...ports,
      // The courier's own completion step is suppressed: this operation owns
      // the ordering, and the origin must not be marked done until the target
      // thread exists.
      completeHandoff: () => Effect.void as Effect.Effect<unknown, E>,
    },
  }).pipe(
    Effect.tapError((error) =>
      Effect.ignore(
        ports.reportFailure({ stage: "transferring", error: describeTransferError(error) }),
      ),
    ),
  );

  yield* ports
    .createContinuationThread({
      threadId: input.targetThreadId,
      worktreePath: transferred.adopted.worktreePath,
    })
    .pipe(
      Effect.tapError((error) =>
        Effect.ignore(
          ports.reportFailure({ stage: "adopting", error: describeTransferError(error) }),
        ),
      ),
    );

  if (input.startImmediately) {
    // Not fatal: the work and the session are already on the other machine, so
    // a failed first turn is something the user can retry there rather than a
    // reason to call the whole handoff failed.
    yield* Effect.ignore(ports.startContinuationTurn({ threadId: input.targetThreadId }));
  }

  yield* ports.completeHandoff({ adoptedSessionId: transferred.adopted.sessionId });

  return transferred;
});

function describeTransferError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "The transfer failed.";
}
