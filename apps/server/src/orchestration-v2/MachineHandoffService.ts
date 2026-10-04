import {
  CommandId,
  MACHINE_HANDOFF_MAX_PAYLOAD_BYTES,
  OrchestrationV2MachineHandoffHistoryEntry,
  type MachineHandoffId,
  type OrchestrationV2MachineHandoffManifest,
  type OrchestrationV2ReadMachineHandoffBundleInput,
  type OrchestrationV2ReadMachineHandoffBundleResult,
  type OrchestrationV2WriteMachineHandoffBundleInput,
  type OrchestrationV2WriteMachineHandoffBundleResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import {
  MachineHandoffError,
  machineHandoffStopCommandId,
  machineHandoffStopProof,
} from "./MachineHandoff.ts";
import { deleteRefs, findRemoteByUrl, machineHandoffRef, pushRef } from "./MachineHandoffGit.ts";
import { makeMachineHandoffStaging, sha256Hex } from "./MachineHandoffStaging.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export { MachineHandoffError };

export interface MachineHandoffServiceShape {
  /** Stages a stopped thread's work and marks the handoff ready. */
  readonly exportBundle: (input: {
    readonly threadId: ThreadId;
    readonly handoffId: MachineHandoffId;
    /** Distinguishes exports of one handoff, so each can mark it ready. */
    readonly attemptKey: string;
  }) => Effect.Effect<void, MachineHandoffError>;
  /** Best-effort removal of a finished or cancelled handoff's bundle and refs. */
  readonly cleanup: (input: {
    readonly threadId: ThreadId;
    readonly handoffId: MachineHandoffId;
  }) => Effect.Effect<void>;
  readonly readBundle: (
    input: OrchestrationV2ReadMachineHandoffBundleInput,
  ) => Effect.Effect<OrchestrationV2ReadMachineHandoffBundleResult, MachineHandoffError>;
  readonly writeBundle: (
    input: OrchestrationV2WriteMachineHandoffBundleInput,
  ) => Effect.Effect<OrchestrationV2WriteMachineHandoffBundleResult, MachineHandoffError>;
  /** The verified manifest and payload a target received, for adopt. */
  readonly readReceived: (handoffId: MachineHandoffId) => Effect.Effect<
    {
      readonly manifest: OrchestrationV2MachineHandoffManifest;
      readonly payload: Uint8Array;
    },
    MachineHandoffError
  >;
  readonly discardReceived: (handoffId: MachineHandoffId) => Effect.Effect<void>;
  /** The worktree an interrupted adopt already made for this handoff, if any. */
  readonly adoptedWorkspace: (
    handoffId: MachineHandoffId,
  ) => Effect.Effect<Option.Option<{ readonly worktreePath: string; readonly branch: string }>>;
  readonly rememberAdoptedWorkspace: (
    handoffId: MachineHandoffId,
    workspace: { readonly worktreePath: string; readonly branch: string },
  ) => Effect.Effect<void, MachineHandoffError>;
}

export class MachineHandoffService extends Context.Service<
  MachineHandoffService,
  MachineHandoffServiceShape
>()("t3/orchestration-v2/MachineHandoffService") {}

/** How long export waits for an interrupted run to end before trying again later. */
const STOP_WAIT = Duration.seconds(20);

const HistoryJson = Schema.fromJsonString(Schema.Array(OrchestrationV2MachineHandoffHistoryEntry));
const encodeHistory = Schema.encodeEffect(HistoryJson);

const refuse = (message: string, cause?: unknown) =>
  new MachineHandoffError(cause === undefined ? { message } : { message, cause });

const isLiveRun = (run: { readonly status: string }) =>
  run.status === "preparing" || run.status === "starting" || run.status === "running";

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const config = yield* ServerConfig;
  const staging = makeMachineHandoffStaging({
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    handoffDir: config.handoffDir,
  });

  /**
   * The thread stopped here: every detach this handoff enqueued succeeded and
   * no run is still live. A run the interrupt has not ended yet is awaited
   * through its events rather than polled.
   */
  const proveStopped = Effect.fn("MachineHandoffService.proveStopped")(function* (
    threadId: ThreadId,
    handoffId: MachineHandoffId,
  ) {
    const detaches = yield* outbox
      .listByCommandId(machineHandoffStopCommandId(handoffId))
      .pipe(Effect.mapError((cause) => refuse("Could not confirm the thread stopped.", cause)));
    const proof = machineHandoffStopProof(
      detaches.flatMap((effect) =>
        effect.request.type === "provider-session.detach"
          ? [{ providerSessionId: effect.request.providerSessionId, status: effect.status }]
          : [],
      ),
    );
    if (proof !== "stopped") {
      return yield* new MachineHandoffError({
        message: "The agent on this machine did not stop. Retry the handoff.",
        retryable: proof === "stopping",
      });
    }
    const after = yield* eventSink.latestSequence({ threadId }).pipe(Effect.orElseSucceed(() => 0));
    const readRuns = threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError((cause) => refuse("Could not read the thread.", cause)));
    if (!(yield* readRuns).runs.some(isLiveRun)) return;
    const ended = yield* eventSink.stream({ threadId, afterSequence: after }).pipe(
      Stream.filter((stored) => stored.event.type === "run.updated"),
      Stream.mapEffect(() => readRuns),
      Stream.filter((records) => !records.runs.some(isLiveRun)),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeoutOption(STOP_WAIT),
      Effect.mapError((cause) => refuse("Could not confirm the thread stopped.", cause)),
    );
    if (Option.isNone(ended)) {
      return yield* new MachineHandoffError({
        message: "The agent on this machine is still stopping.",
        retryable: true,
      });
    }
  });

  /** The provider's own session, when its adapter can move one. Missing means portable. */
  const exportNativeSession = Effect.fn("MachineHandoffService.exportNativeSession")(function* (
    projection: ProjectionStore.ProjectionRecords<"providerThreads">,
    cwd: string,
  ) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId ?? null;
    if (providerThread === undefined || nativeThreadId === null) return null;
    const adapter = yield* adapters.get(providerThread.providerInstanceId).pipe(Effect.option);
    const transfer = Option.getOrUndefined(adapter)?.nativeSessionTransfer;
    if (transfer === undefined) return null;
    const session = yield* transfer
      .export({ nativeThreadId, cwd })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Machine handoff could not read the native session", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
    return session === null ? null : { driver: providerThread.driver, nativeThreadId, session };
  });

  const readHistory = (threadId: ThreadId) =>
    projections.getTurnStartHistory(threadId).pipe(
      Effect.map((items) =>
        items.flatMap((item) =>
          (item.type === "user_message" || item.type === "assistant_message") &&
          item.text.trim().length > 0
            ? [
                {
                  role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
                  text: item.text,
                  createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
                },
              ]
            : [],
        ),
      ),
      Effect.mapError((cause) => refuse("Could not read the conversation.", cause)),
    );

  const exportBundle: MachineHandoffServiceShape["exportBundle"] = Effect.fn(
    "MachineHandoffService.exportBundle",
  )(function* (input) {
    const projection = yield* threads
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => refuse("Could not read the thread.", cause)));
    const handoff = projection.thread.machineHandoff;
    // A cancelled, superseded or deleted handoff has nothing left to export.
    if (
      handoff?.id !== input.handoffId ||
      handoff.state !== "exporting" ||
      projection.thread.deletedAt !== null
    ) {
      return;
    }

    yield* proveStopped(input.threadId, input.handoffId);
    const originStoppedAt = DateTime.formatIso(yield* DateTime.now);

    // The provider keyed its session on the directory it ran in.
    const cwd = (yield* runtimePolicy
      .resolve({ thread: projection.thread, modelSelection: projection.thread.modelSelection })
      .pipe(Effect.mapError((cause) => refuse("Could not find the thread's workspace.", cause))))
      .cwd;
    if (cwd === null) return yield* refuse("This thread has no workspace to hand off.");

    const native = yield* exportNativeSession(projection, cwd);
    const historyBytes = new TextEncoder().encode(
      yield* encodeHistory(yield* readHistory(input.threadId)).pipe(
        Effect.mapError((cause) => refuse("Could not read the conversation.", cause)),
      ),
    );
    const nativeBytes = native?.session.bytes ?? new Uint8Array(0);
    const payload = new Uint8Array(nativeBytes.length + historyBytes.length);
    payload.set(nativeBytes, 0);
    payload.set(historyBytes, nativeBytes.length);
    if (payload.length > MACHINE_HANDOFF_MAX_PAYLOAD_BYTES) {
      return yield* refuse("This thread's session is too large to hand off.");
    }

    const identity = yield* identities.resolve(cwd, { refresh: true });
    if (identity === null) {
      return yield* refuse("Both machines need a git remote they can reach.");
    }
    const ref = machineHandoffRef(input.handoffId);
    const published = yield* checkpoints
      .publishHandoffCommit({ cwd, ref })
      .pipe(Effect.mapError((cause) => refuse("Could not snapshot the work to hand off.", cause)));
    yield* pushRef(git, { cwd, remote: identity.locator.remoteName, ref }).pipe(
      Effect.mapError((cause) =>
        refuse(
          `Could not push the work to '${identity.locator.remoteName}'. Both machines need a git remote they can reach.`,
          cause,
        ),
      ),
    );

    const origin = yield* environment.getDescriptor;
    yield* staging.writePayload(input.handoffId, payload);
    yield* staging.writeManifest({
      version: 1,
      handoffId: input.handoffId,
      originEnvironmentId: origin.environmentId,
      originEnvironmentLabel: origin.label,
      originThreadId: input.threadId,
      targetThreadId: handoff.target.threadId,
      thread: {
        title: projection.thread.title,
        modelSelection: projection.thread.modelSelection,
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
        originBranch: projection.thread.branch,
      },
      native:
        native === null
          ? null
          : {
              driver: native.driver,
              nativeThreadId: native.nativeThreadId,
              fileName: native.session.fileName,
              bytes: nativeBytes.length,
            },
      historyBytes: historyBytes.length,
      payloadBytes: payload.length,
      payloadSha256: sha256Hex(payload),
      git: {
        remoteUrl: identity.locator.remoteUrl,
        ref,
        commit: published.commit,
        baseCommit: published.baseCommit,
      },
      originStoppedAt,
    });
    yield* threads
      .dispatch({
        type: "thread.machine-handoff.ready",
        commandId: CommandId.make(`${input.attemptKey}:ready`),
        threadId: input.threadId,
        handoffId: input.handoffId,
      })
      .pipe(Effect.mapError((cause) => refuse("Could not mark the handoff ready.", cause)));
  });

  const cleanup: MachineHandoffServiceShape["cleanup"] = (input) =>
    Effect.gen(function* () {
      const manifest = yield* staging.readManifest(input.handoffId);
      yield* staging.discard(input.handoffId);
      const thread = yield* threads.getThreadRecords(input.threadId, []);
      const cwd = (yield* runtimePolicy.resolve({
        thread: thread.thread,
        modelSelection: thread.thread.modelSelection,
      })).cwd;
      if (cwd === null) return;
      const remote = Option.isSome(manifest)
        ? yield* findRemoteByUrl(git, cwd, manifest.value.git.remoteUrl)
        : ((yield* identities.resolve(cwd))?.locator.remoteName ?? null);
      yield* deleteRefs(git, { cwd, ref: machineHandoffRef(input.handoffId), remote });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Machine handoff cleanup was incomplete", {
          handoffId: input.handoffId,
          cause,
        }),
      ),
    );

  const readBundle: MachineHandoffServiceShape["readBundle"] = (input) =>
    Effect.gen(function* () {
      const manifest = yield* staging.readManifest(input.handoffId);
      if (Option.isNone(manifest)) {
        return yield* refuse("This handoff is not staged on this machine.");
      }
      const chunk = yield* staging.readChunk(input.handoffId, input.offset, input.length);
      return {
        manifest: manifest.value,
        chunk: Buffer.from(chunk.bytes).toString("base64"),
        totalBytes: chunk.totalBytes,
      };
    });

  const writeBundle: MachineHandoffServiceShape["writeBundle"] = (input) =>
    Effect.gen(function* () {
      if (input.offset === 0) {
        if (input.manifest === undefined) {
          return yield* refuse("The handoff transfer started without its manifest.");
        }
        if (input.manifest.handoffId !== input.handoffId) {
          return yield* refuse("The handoff manifest belongs to another handoff.");
        }
        if (input.manifest.payloadBytes > MACHINE_HANDOFF_MAX_PAYLOAD_BYTES) {
          return yield* refuse("The handoff is too large to move.");
        }
        yield* staging.writeManifest(input.manifest);
      } else if (Option.isNone(yield* staging.readManifest(input.handoffId))) {
        return yield* refuse("The handoff transfer lost its start. Try again.");
      }
      const receivedBytes = yield* staging.writeChunk(
        input.handoffId,
        input.offset,
        new Uint8Array(Buffer.from(input.chunk, "base64")),
      );
      return { receivedBytes };
    });

  const readReceived: MachineHandoffServiceShape["readReceived"] = (handoffId) =>
    Effect.gen(function* () {
      const manifest = yield* staging.readManifest(handoffId);
      if (Option.isNone(manifest)) {
        return yield* refuse("This handoff has not arrived on this machine.");
      }
      if (manifest.value.originStoppedAt.trim().length === 0) {
        return yield* refuse("The handoff does not show the other machine stopped.");
      }
      return {
        manifest: manifest.value,
        payload: yield* staging.readVerifiedPayload(manifest.value),
      };
    });

  return MachineHandoffService.of({
    exportBundle,
    cleanup,
    readBundle,
    writeBundle,
    readReceived,
    discardReceived: staging.discard,
    adoptedWorkspace: staging.readAdoptedWorkspace,
    rememberAdoptedWorkspace: staging.writeAdoptedWorkspace,
  });
});

export const layer = Layer.effect(MachineHandoffService, make);
