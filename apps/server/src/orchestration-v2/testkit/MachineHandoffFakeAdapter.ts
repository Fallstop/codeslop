import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2NativeSessionTransfer,
  ProviderAdapterV2Shape,
} from "../ProviderAdapter.ts";

export interface MachineHandoffFakeAdapterOptions {
  readonly instanceId?: string;
  readonly driver?: string;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  /** Answer every turn with this reply and complete it, instead of leaving it running. */
  readonly reply?: string;
  readonly nativeSessionTransfer?: ProviderAdapterV2NativeSessionTransfer;
  readonly nativeThreadId?: string;
  /** Runs when a session's scope closes, so a test can make release fail. */
  readonly onRelease?: Effect.Effect<void>;
}

/** What the fake provider did, in order. */
export type FakeAdapterLogEntry = "turn-started" | "interrupted" | "session-released";

/**
 * A provider that runs in memory: turns start and either complete with a
 * reply or run until interrupted, which ends them the way a real provider
 * reports it.
 */
export const makeMachineHandoffFakeAdapter = Effect.fn("makeMachineHandoffFakeAdapter")(function* (
  options: MachineHandoffFakeAdapterOptions = {},
) {
  const log: Array<FakeAdapterLogEntry> = [];
  const instanceId = ProviderInstanceId.make(options.instanceId ?? "codex");
  const driver = ProviderDriverKind.make(options.driver ?? "codex");
  const capabilities = options.capabilities ?? CodexProviderCapabilitiesV2;
  const nativeId = options.nativeThreadId ?? "native-thread";
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const turns = new Map<string, { turn: OrchestrationV2ProviderTurn; runOrdinal: number }>();

  const finish = (providerTurnId: ProviderTurnId, status: "completed" | "interrupted") =>
    Effect.gen(function* () {
      const running = turns.get(providerTurnId);
      if (running === undefined || running.turn.status !== "running") return;
      const now = yield* DateTime.now;
      const turn = { ...running.turn, status, completedAt: now };
      turns.set(providerTurnId, { ...running, turn });
      yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn: turn });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId,
        runOrdinal: running.runOrdinal,
        status,
        failure: null,
        threadDisposition: "reusable",
      });
    });

  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    ...(options.nativeSessionTransfer === undefined
      ? {}
      : { nativeSessionTransfer: options.nativeSessionTransfer }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => log.push("session-released")).pipe(
            Effect.andThen(options.onRelease ?? Effect.void),
          ),
        );
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? "/",
            model: input.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${driver}:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              log.push("turn-started");
              const started = yield* DateTime.now;
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: started,
                completedAt: null,
              };
              turns.set(providerTurn.id, { turn: providerTurn, runOrdinal: turn.runOrdinal });
              yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
              if (options.reply === undefined) return;
              yield* Queue.offer(events, {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`reply:${turn.attemptId}`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: providerTurn.id,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "completed",
                  title: null,
                  startedAt: started,
                  completedAt: started,
                  updatedAt: started,
                  type: "assistant_message",
                  messageId: MessageId.make(`reply:${turn.attemptId}`),
                  text: options.reply,
                  streaming: false,
                },
              });
              yield* finish(providerTurn.id, "completed");
            }),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: (interrupt) =>
            Effect.gen(function* () {
              log.push("interrupted");
              yield* finish(interrupt.providerTurnId, "interrupted");
            }),
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  return { adapter, log, instanceId, driver, nativeId };
});
