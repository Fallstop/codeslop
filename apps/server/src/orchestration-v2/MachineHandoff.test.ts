import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MachineHandoffId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { machineHandoffStopProof } from "./MachineHandoff.ts";
import * as MachineHandoffService from "./MachineHandoffService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const threadId = ThreadId.make("thread:machine-handoff");
const handoffId = MachineHandoffId.make("handoff-1");
const target = {
  environmentId: EnvironmentId.make("environment:desktop"),
  threadId: ThreadId.make("thread:machine-handoff-target"),
  environmentLabel: "Desktop",
};

/** What happened, in order, across the adapter and the handoff service. */
type LogEntry = "turn-started" | "interrupted" | "session-released" | "exported" | "cleaned-up";

interface Harness {
  readonly log: Array<LogEntry>;
  readonly exportResult: {
    current: Effect.Effect<void, MachineHandoffService.MachineHandoffError>;
  };
}

function makeHarness() {
  const log: Array<LogEntry> = [];
  const harness: Harness = { log, exportResult: { current: Effect.void } };
  return Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("machine-handoff");
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const adapter: ProviderAdapterV2Shape = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* Effect.addFinalizer(() => Effect.sync(() => log.push("session-released")));
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
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
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                });
              }),
            steerTurn: () => Effect.die("unused"),
            interruptTurn: () => Effect.sync(() => log.push("interrupted")),
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layer = ProviderReplayHarness.layerWithRegistry(
      { name: "machine-handoff" },
      ProviderAdapterRegistry.layerSingle(adapter),
      {
        runEffectWorker: false,
        machineHandoffLayer: Layer.succeed(MachineHandoffService.MachineHandoffService, {
          exportBundle: () =>
            Effect.suspend(() => harness.exportResult.current).pipe(
              Effect.tap(() => Effect.sync(() => log.push("exported"))),
            ),
          cleanup: () => Effect.sync(() => log.push("cleaned-up")),
          readBundle: () => Effect.die("unused"),
          writeBundle: () => Effect.die("unused"),
          readReceived: () => Effect.die("unused"),
          discardReceived: () => Effect.die("unused"),
          adoptedWorkspace: () => Effect.die("unused"),
          rememberAdoptedWorkspace: () => Effect.die("unused"),
        }),
      },
    );
    return { harness, cwd, layer };
  });
}

const create = (cwd: string) => ({
  type: "thread.create" as const,
  commandId: CommandId.make("create"),
  threadId,
  projectId: ProjectId.make("project:machine-handoff"),
  title: "Machine handoff",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: cwd,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

const message = (id: string, overrides: Partial<{ createdBy: "user" | "agent" }> = {}) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`message:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: overrides.createdBy ?? ("user" as const),
  creationSource: overrides.createdBy === "agent" ? ("server" as const) : ("web" as const),
});

const start = (commandId = "handoff:start") => ({
  type: "thread.machine-handoff.start" as const,
  commandId: CommandId.make(commandId),
  threadId,
  handoffId,
  target,
});

const awaitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

const rejection = (error: Orchestrator.OrchestratorV2Error) =>
  error._tag === "OrchestratorDispatchError" ? String(error.cause) : error.message;

const handoffOf = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return (yield* orchestrator.getThreadProjection(threadId)).thread.machineHandoff ?? null;
});

/** Starts a turn and waits until the provider reports it running. */
const startRunningTurn = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const running = yield* awaitEvent(
    (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
  );
  yield* orchestrator.dispatch(message("first"));
  yield* worker.drain();
  yield* Fiber.join(running);
});

it.effect("freezes a running thread and exports only after detaching its session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, cwd, layer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch(create(cwd));
        yield* startRunningTurn;
        yield* orchestrator.dispatch({
          ...message("queued"),
          dispatchMode: { type: "queue_after_active" },
        });

        yield* orchestrator.dispatch(start());
        const frozen = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(frozen.thread.machineHandoff?.state, "exporting");
        assert.isTrue(
          frozen.runs
            .filter((run) => run.status === "queued")
            .every((run) => run.queueHeld === true),
        );
        assert.lengthOf(frozen.providerSessions, 0);

        yield* worker.drain();
        // The interrupt waits for the turn to end, so the detach that follows
        // has nothing left to interrupt. Export runs only after both.
        const work = harness.log.filter((entry) => entry !== "session-released");
        assert.deepEqual(work, ["turn-started", "interrupted", "exported"]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("refuses a user's message while handed off and drops automatic deliveries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(create(cwd));
        yield* orchestrator.dispatch(start());

        const refused = yield* orchestrator.dispatch(message("user")).pipe(Effect.flip);
        assert.include(rejection(refused), "being handed off to Desktop");

        yield* orchestrator.dispatch(message("wake", { createdBy: "agent" }));
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(projection.runs, 0);

        const resume = yield* orchestrator
          .dispatch({ type: "queue.resume", commandId: CommandId.make("resume"), threadId })
          .pipe(Effect.flip);
        assert.include(rejection(resume), "being handed off");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("cancels a start that has not reached the provider yet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, cwd, layer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch(create(cwd));
        yield* orchestrator.dispatch(message("first"));
        yield* orchestrator.dispatch(start());
        yield* worker.drain();
        assert.notInclude(harness.log, "turn-started");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "interrupted");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("cancel is accepted from every state and always gives the thread back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, cwd, layer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch(create(cwd));
        const cancel = (id: string) =>
          orchestrator.dispatch({
            type: "thread.machine-handoff.cancel",
            commandId: CommandId.make(`cancel:${id}`),
            threadId,
          });
        // Nothing to cancel is still accepted.
        yield* cancel("none");

        const reach = {
          exporting: Effect.void,
          ready: orchestrator.dispatch({
            type: "thread.machine-handoff.ready",
            commandId: CommandId.make("ready"),
            threadId,
            handoffId,
          }),
          failed: orchestrator.dispatch({
            type: "thread.machine-handoff.fail",
            commandId: CommandId.make("fail"),
            threadId,
            handoffId,
            error: "Both machines need a git remote they can reach.",
          }),
          completed: Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.machine-handoff.ready",
              commandId: CommandId.make("ready-then-complete"),
              threadId,
              handoffId,
            });
            yield* orchestrator.dispatch({
              type: "thread.machine-handoff.complete",
              commandId: CommandId.make("complete"),
              threadId,
              handoffId,
              target,
            });
          }),
        };
        for (const [state, reachState] of Object.entries(reach)) {
          yield* orchestrator.dispatch(start(`start:${state}`));
          yield* reachState;
          assert.equal((yield* handoffOf)?.state, state);
          yield* cancel(state);
          assert.isNull(yield* handoffOf);
          yield* cancel(`${state}:again`);
        }
        yield* worker.drain();
        // Completing cleans up the published work too, before the take back does.
        assert.lengthOf(
          harness.log.filter((entry) => entry === "cleaned-up"),
          5,
        );
        // Taken back: the thread runs here again.
        yield* orchestrator.dispatch(message("after"));
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("complete needs a staged bundle, and fail and retry follow the current handoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, cwd, layer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch(create(cwd));
        yield* orchestrator.dispatch(start());
        const complete = (id: string) =>
          orchestrator.dispatch({
            type: "thread.machine-handoff.complete",
            commandId: CommandId.make(id),
            threadId,
            handoffId,
            target,
          });
        yield* complete("complete:early").pipe(Effect.flip);

        // A fail for some other handoff changes nothing.
        yield* orchestrator.dispatch({
          type: "thread.machine-handoff.fail",
          commandId: CommandId.make("fail:stale"),
          threadId,
          handoffId: MachineHandoffId.make("handoff-other"),
          error: "Stale.",
        });
        assert.equal((yield* handoffOf)?.state, "exporting");

        harness.exportResult.current = Effect.fail(
          new MachineHandoffService.MachineHandoffError({
            message: "Both machines need a git remote they can reach.",
          }),
        );
        yield* worker.drain();
        const failed = yield* handoffOf;
        assert.equal(failed?.state, "failed");
        assert.equal(failed?.error, "Both machines need a git remote they can reach.");

        harness.exportResult.current = Effect.void;
        yield* orchestrator.dispatch({
          type: "thread.machine-handoff.retry",
          commandId: CommandId.make("retry"),
          threadId,
          handoffId,
        });
        assert.equal((yield* handoffOf)?.state, "exporting");
        assert.isUndefined((yield* handoffOf)?.error);
        yield* worker.drain();
        assert.deepEqual(harness.log, ["exported"]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it("proves a stop only once every session has detached", () => {
  const detach = (providerSessionId: string, status: string) => ({ providerSessionId, status });
  assert.equal(machineHandoffStopProof([]), "stopped");
  assert.equal(
    machineHandoffStopProof([
      detach("a", "failed"),
      detach("a", "succeeded"),
      detach("b", "succeeded"),
    ]),
    "stopped",
  );
  assert.equal(
    machineHandoffStopProof([detach("a", "succeeded"), detach("b", "pending")]),
    "stopping",
  );
  // A session whose every detach failed may still be running here.
  assert.equal(
    machineHandoffStopProof([detach("a", "failed"), detach("b", "pending")]),
    "not_stopped",
  );
});
