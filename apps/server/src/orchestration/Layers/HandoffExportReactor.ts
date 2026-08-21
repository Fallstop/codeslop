import {
  CommandId,
  defaultInstanceIdForDriver,
  type OrchestrationEvent,
  type ProviderDriverKind,
  type ThreadHandoffStage,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { HandoffExportService } from "../../handoff/HandoffExportService.ts";
import { resolveHandoffProviderHome } from "../../handoff/HandoffProviderHome.ts";
import { readHandoffSessionId } from "../../handoff/HandoffSessionCursor.ts";
import { isTransferableProvider } from "../../handoff/HandoffSessionTransfer.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  HandoffExportReactor,
  type HandoffExportReactorShape,
} from "../Services/HandoffExportReactor.ts";

type HandoffStartedEvent = Extract<OrchestrationEvent, { type: "thread.handoff-started" }>;

/**
 * Refusals are reported as a parked failure rather than thrown away: the
 * thread is already frozen by the time most of these can happen, so the user
 * needs the reason and a way out, not silence.
 */
class HandoffExportRefused extends Data.TaggedError("HandoffExportRefused")<{
  readonly reason: string;
}> {}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const providerSessionRuntime = yield* ProviderSessionRuntimeRepository;
  const exportService = yield* HandoffExportService;
  const settingsService = yield* ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment;

  const dispatchStage = (event: HandoffStartedEvent, stage: ThreadHandoffStage) =>
    orchestrationEngine
      .dispatch({
        type: "thread.handoff.stage",
        // Derived from the event so a replay resolves to the same command
        // instead of minting a fresh one.
        commandId: CommandId.make(`handoff-stage:${event.eventId}:${stage}`),
        threadId: event.payload.threadId,
        handoffId: event.payload.handoff.handoffId,
        stage,
      })
      .pipe(Effect.asVoid, Effect.ignore);

  const dispatchFailure = (event: HandoffStartedEvent, stage: ThreadHandoffStage, error: string) =>
    orchestrationEngine
      .dispatch({
        type: "thread.handoff.fail",
        commandId: CommandId.make(`handoff-fail:${event.eventId}:${stage}`),
        threadId: event.payload.threadId,
        handoffId: event.payload.handoff.handoffId,
        stage,
        error,
      })
      .pipe(Effect.asVoid, Effect.ignore);

  const exportForEvent = Effect.fn("HandoffExportReactor.exportForEvent")(function* (
    event: HandoffStartedEvent,
  ) {
    const threadId = event.payload.threadId;

    const threadRow = yield* projectionThreadRepository.getById({ threadId });
    if (Option.isNone(threadRow)) {
      return yield* Effect.fail(
        new HandoffExportRefused({ reason: "This thread no longer exists." }),
      );
    }
    const cwd = threadRow.value.worktreePath;
    if (cwd === null) {
      return yield* Effect.fail(
        new HandoffExportRefused({ reason: "This thread has no workspace on disk to hand off." }),
      );
    }

    const runtimeRow = yield* providerSessionRuntime.getByThreadId({ threadId });
    if (Option.isNone(runtimeRow)) {
      return yield* Effect.fail(
        new HandoffExportRefused({ reason: "This thread has never started a provider session." }),
      );
    }
    const providerName = runtimeRow.value.providerName;
    if (!isTransferableProvider(providerName)) {
      return yield* Effect.fail(
        new HandoffExportRefused({ reason: `Threads on ${providerName} cannot be handed off.` }),
      );
    }
    const sessionId = readHandoffSessionId(providerName, runtimeRow.value.resumeCursor);
    if (sessionId === null) {
      return yield* Effect.fail(
        new HandoffExportRefused({ reason: "This thread has no resumable session to carry." }),
      );
    }

    const settings = yield* settingsService.getSettings;
    const instanceId =
      runtimeRow.value.providerInstanceId ??
      defaultInstanceIdForDriver(providerName as ProviderDriverKind);
    const instance = settings.providerInstances[instanceId];
    if (instance === undefined) {
      return yield* Effect.fail(
        new HandoffExportRefused({
          reason: `Provider instance '${instanceId}' is no longer configured.`,
        }),
      );
    }
    const home = yield* resolveHandoffProviderHome(instance);
    if (home === null) {
      return yield* Effect.fail(
        new HandoffExportRefused({ reason: `Threads on ${providerName} cannot be handed off.` }),
      );
    }

    // The freeze. Stopping is the only path that cancels a pending approval and
    // flushes buffered assistant text, and it has no running-turn guard — which
    // is what lets a handoff happen mid-work instead of refusing.
    yield* providerService.stopSession({ threadId });
    const originStoppedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    yield* dispatchStage(event, "exporting");

    const descriptor = yield* serverEnvironment.getDescriptor;
    yield* exportService.exportBundle({
      handoffId: event.payload.handoff.handoffId,
      originThreadId: threadId,
      originEnvironmentId: descriptor.environmentId,
      targetThreadId: event.payload.handoff.target.threadId,
      provider: home.provider,
      providerHome: home.providerHome,
      sessionId,
      cwd,
      originStoppedAt,
      ...(threadRow.value.branch !== null ? { originBranch: threadRow.value.branch } : {}),
    });

    yield* dispatchStage(event, "staged");
  });

  const processSafely = (event: HandoffStartedEvent) =>
    exportForEvent(event).pipe(
      // A refusal already carries language meant for the banner.
      Effect.catchTag("HandoffExportRefused", (error) =>
        dispatchFailure(event, "exporting", error.reason),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("handoff export failed", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(dispatchFailure(event, "exporting", "Preparing the handoff failed.")),
        );
      }),
    );

  const worker = yield* makeDrainableWorker(processSafely);

  const start: HandoffExportReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.handoff-started") {
          return Effect.void;
        }
        // Only the freezing stage means "just started"; a re-emitted record for
        // an already-advancing handoff must not export twice.
        if (event.payload.handoff.stage !== "freezing") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies HandoffExportReactorShape;
});

export const HandoffExportReactorLive = Layer.effect(HandoffExportReactor, make);
