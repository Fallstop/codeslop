import {
  CommandId,
  EnvironmentId,
  HandoffId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadHandoffLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ADOPTED_AT = "2026-01-01T01:00:00.000Z";

const TARGET: ThreadHandoffLink = {
  environmentId: EnvironmentId.make("env-desktop"),
  threadId: ThreadId.make("thread-adopted"),
  at: ADOPTED_AT,
  environmentLabel: "Studio PC",
};

function makeReadModel(input: {
  readonly handedOffTo?: OrchestrationThread["handedOffTo"];
  readonly handoff?: OrchestrationThread["handoff"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        ...(input.handedOffTo !== undefined ? { handedOffTo: input.handedOffTo } : {}),
        ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread handoff decider", (it) => {
  it.effect("stamps the link the work moved to", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.complete",
          commandId: CommandId.make("cmd-complete"),
          threadId: ThreadId.make("thread-1"),
          target: TARGET,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.handed-off");
      if (events[0]?.type === "thread.handed-off") {
        expect(events[0].payload.handedOffTo).toEqual(TARGET);
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("re-completing to the same environment does not churn updatedAt", () =>
    Effect.gen(function* () {
      // A retried receipt or a raced second client must land on the recorded
      // link, so the projection write is a no-op rather than a fresh stamp.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.complete",
          commandId: CommandId.make("cmd-complete-again"),
          threadId: ThreadId.make("thread-1"),
          target: { ...TARGET, at: "2026-06-06T06:06:06.000Z" },
        },
        readModel: makeReadModel({ handedOffTo: TARGET }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.handed-off") {
        expect(events[0].payload.handedOffTo).toEqual(TARGET);
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("re-handing off to a different environment stamps the new target", () =>
    Effect.gen(function* () {
      // Preserving the original the way settle does would leave handedOffTo
      // aimed at a machine that no longer has the work.
      const nextTarget: ThreadHandoffLink = {
        environmentId: EnvironmentId.make("env-laptop"),
        threadId: ThreadId.make("thread-adopted-again"),
        at: ADOPTED_AT,
      };
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.complete",
          commandId: CommandId.make("cmd-complete-move"),
          threadId: ThreadId.make("thread-1"),
          target: nextTarget,
        },
        readModel: makeReadModel({ handedOffTo: TARGET }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.handed-off") {
        expect(events[0].payload.handedOffTo).toEqual(nextTarget);
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("starting a handoff freezes the thread before anything moves", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.start",
          commandId: CommandId.make("cmd-start"),
          threadId: ThreadId.make("thread-1"),
          handoffId: HandoffId.make("handoff-1"),
          target: TARGET,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.handoff-started");
      if (events[0]?.type === "thread.handoff-started") {
        expect(events[0].payload.handoff.stage).toBe("freezing");
        expect(events[0].payload.handoff.handoffId).toBe("handoff-1");
      }
    }),
  );

  it.effect("refuses a second handoff while one is in flight", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.start",
          commandId: CommandId.make("cmd-start-conflict"),
          threadId: ThreadId.make("thread-1"),
          handoffId: HandoffId.make("handoff-2"),
          target: TARGET,
        },
        readModel: makeReadModel({
          handoff: {
            handoffId: HandoffId.make("handoff-1"),
            target: TARGET,
            stage: "transferring",
            startedAt: NOW,
          },
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses a stage that names a handoff which is not in flight", () =>
    Effect.gen(function* () {
      // A stale client must not resurrect a cancelled transfer.
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.stage",
          commandId: CommandId.make("cmd-stage-stale"),
          threadId: ThreadId.make("thread-1"),
          handoffId: HandoffId.make("handoff-gone"),
          stage: "transferring",
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("a failure parks the handoff rather than clearing it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.fail",
          commandId: CommandId.make("cmd-fail"),
          threadId: ThreadId.make("thread-1"),
          handoffId: HandoffId.make("handoff-1"),
          stage: "transferring",
          error: "target refused the bundle",
        },
        readModel: makeReadModel({
          handoff: {
            handoffId: HandoffId.make("handoff-1"),
            target: TARGET,
            stage: "transferring",
            startedAt: NOW,
          },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.handoff-failed");
      if (events[0]?.type === "thread.handoff-failed") {
        expect(events[0].payload.error).toBe("target refused the bundle");
      }
    }),
  );

  it.effect("cancelling never refuses, even with nothing in flight", () =>
    Effect.gen(function* () {
      // Cancel is an escape hatch; if it could refuse it would be a one-way door.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.cancel",
          commandId: CommandId.make("cmd-cancel-noop"),
          threadId: ThreadId.make("thread-1"),
          handoffId: HandoffId.make("handoff-gone"),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.handoff-cancelled");
      if (events[0]?.type === "thread.handoff-cancelled") {
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("rejects a turn on a thread that was handed off", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-departed"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("msg-1"),
            role: "user",
            text: "keep going",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ handedOffTo: TARGET }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a turn while a handoff is still in flight", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-inflight"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("msg-1"),
            role: "user",
            text: "keep going",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          handoff: {
            handoffId: HandoffId.make("handoff-1"),
            target: TARGET,
            stage: "transferring",
            startedAt: NOW,
          },
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("clearing the handoff lets the thread run here again", () =>
    Effect.gen(function* () {
      const cleared = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.clear",
          commandId: CommandId.make("cmd-clear"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel({ handedOffTo: TARGET }),
      });
      const clearedEvents = Array.isArray(cleared) ? cleared : [cleared];
      expect(clearedEvents[0]?.type).toBe("thread.handoff-cleared");
      if (clearedEvents[0]?.type === "thread.handoff-cleared") {
        expect(clearedEvents[0].payload.reason).toBe("user");
      }

      // The reverse state is the whole point: a thread whose link was cleared
      // is owned here again, so the guard must let a turn through.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-after-clear"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("msg-1"),
            role: "user",
            text: "keep going",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.some((entry) => entry.type === "thread.turn-start-requested")).toBe(true);
    }),
  );

  it.effect("clearing a thread this environment still owns does not churn updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.clear",
          commandId: CommandId.make("cmd-clear-noop"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.handoff-cleared") {
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );
});
