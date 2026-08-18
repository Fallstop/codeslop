import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

/**
 * The `thread.delete` commands that clear a deleted thread's side chats.
 *
 * Command ids are derived from the parent event rather than generated, so a
 * replayed deletion resolves to the same commands instead of a fresh set.
 */
export const buildSideChatDeleteCommands = (input: {
  readonly eventId: string;
  readonly children: ReadonlyArray<{
    readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
  }>;
}): ReadonlyArray<{
  readonly type: "thread.delete";
  readonly commandId: CommandId;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}> =>
  input.children.map((child) => ({
    type: "thread.delete" as const,
    commandId: CommandId.make(`thread-delete-cascade:${input.eventId}:${child.threadId}`),
    threadId: child.threadId,
  }));

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectionThreadRepository = yield* ProjectionThreadRepository;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  /**
   * Delete the side chats opened from a thread that has just been deleted.
   *
   * Dispatched as ordinary `thread.delete` commands rather than handled here:
   * each child then flows back through this reactor, so its provider session
   * and terminals are torn down by the same path, and a side chat of a side
   * chat is covered without this needing to recurse itself.
   *
   * Command ids are derived from the parent event so a replayed deletion
   * resolves to the same commands instead of a fresh set.
   */
  const deleteSideChats = Effect.fn("deleteSideChats")(function* (event: ThreadDeletedEvent) {
    const { threadId } = event.payload;
    const children = yield* projectionThreadRepository
      .listByParentThreadId({ parentThreadId: threadId })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("thread deletion cleanup could not list side chats", {
            threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as([])),
        ),
      );

    yield* Effect.forEach(
      buildSideChatDeleteCommands({ eventId: event.eventId, children }),
      (command) =>
        // A child already gone (raced, or this event replayed) fails the
        // decider's existence check; that is the desired end state either way.
        logCleanupCauseUnlessInterrupted({
          effect: orchestrationEngine.dispatch(command).pipe(Effect.asVoid),
          message: "thread deletion cleanup skipped side chat delete",
          threadId: command.threadId,
        }),
      { discard: true, concurrency: 1 },
    );
  });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* deleteSideChats(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
