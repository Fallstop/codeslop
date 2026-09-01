import {
  CommandId,
  CorrelationId,
  EventId,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  buildSideChatDeleteCommands,
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("buildSideChatDeleteCommands", () => {
  it("deletes every side chat of the deleted thread", () => {
    const commands = buildSideChatDeleteCommands({
      eventId: "event-1",
      children: [{ threadId: ThreadId.make("side-a") }, { threadId: ThreadId.make("side-b") }],
    });

    expect(commands.map((command) => [command.type, command.threadId])).toEqual([
      ["thread.delete", "side-a"],
      ["thread.delete", "side-b"],
    ]);
  });

  it("derives command ids from the event so a replay resolves to the same commands", () => {
    const children = [{ threadId: ThreadId.make("side-a") }];
    const first = buildSideChatDeleteCommands({ eventId: "event-1", children });
    const replay = buildSideChatDeleteCommands({ eventId: "event-1", children });
    const laterDeletion = buildSideChatDeleteCommands({ eventId: "event-2", children });

    expect(first[0]?.commandId).toBe(replay[0]?.commandId);
    expect(first[0]?.commandId).not.toBe(laterDeletion[0]?.commandId);
  });

  it("gives each side chat its own command id", () => {
    const commands = buildSideChatDeleteCommands({
      eventId: "event-1",
      children: [{ threadId: ThreadId.make("side-a") }, { threadId: ThreadId.make("side-b") }],
    });

    expect(new Set(commands.map((command) => command.commandId)).size).toBe(2);
  });

  it("emits nothing for a thread with no side chats", () => {
    expect(buildSideChatDeleteCommands({ eventId: "event-1", children: [] })).toEqual([]);
  });
});

describe("ThreadDeletionReactor drain", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const threadId = ThreadId.make("thread-deletion-reactor-drain");
  const deletedEvent = (sequence: number): OrchestrationEvent => ({
    sequence,
    eventId: EventId.make(`evt-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.deleted",
    occurredAt: now,
    commandId: CommandId.make(`cmd-deleted-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-deleted-${sequence}`),
    metadata: {},
    payload: { threadId, deletedAt: now },
  });

  effectIt.effect("waits for a published deletion the subscriber has not consumed yet", () =>
    Effect.gen(function* () {
      const stops: Array<number> = [];
      const firstCleanupDone = yield* Deferred.make<void>();
      // The engine has already committed and published sequence 2, but the
      // subscriber has not received it yet: the stream releases it on demand.
      const releaseSecondEvent = yield* Deferred.make<void>();
      const latestSequence = yield* Ref.make(0);
      const engine = {
        latestSequence: Ref.get(latestSequence),
        streamDomainEvents: Stream.concat(
          Stream.make(deletedEvent(1)),
          Stream.fromEffect(Deferred.await(releaseSecondEvent)).pipe(
            Stream.map(() => deletedEvent(2)),
          ),
        ),
      } as unknown as OrchestrationEngineShape;
      const providerService = {
        stopSession: () =>
          Effect.gen(function* () {
            stops.push(stops.length + 1);
            if (stops.length === 1) {
              yield* Deferred.succeed(firstCleanupDone, undefined);
            }
          }),
      } as unknown as ProviderServiceShape;
      const terminalManager = {
        close: () => Effect.void,
      } as unknown as TerminalManager.TerminalManager["Service"];
      // These threads have no side chats; the cascade only needs an empty list.
      const projectionThreads = {
        listByParentThreadId: () => Effect.succeed([]),
      } as unknown as ProjectionThreadRepositoryShape;
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
        Layer.provide(Layer.succeed(ProjectionThreadRepository, projectionThreads)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* ThreadDeletionReactor;
          yield* reactor.start();
          yield* Deferred.await(firstCleanupDone);

          // Sequence 1 is fully cleaned and the worker queue is idle. Sequence
          // 2 is committed and published but still in flight to the subscriber.
          yield* Ref.set(latestSequence, 2);
          const drained = yield* Effect.forkChild(reactor.drainThrough(2));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(stops).toEqual([1]);
          expect(drained.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseSecondEvent, undefined);
          yield* Fiber.join(drained);
          expect(stops).toEqual([1, 2]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
