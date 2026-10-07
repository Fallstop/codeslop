import {
  CommandId,
  defaultInstanceIdForDriver,
  OrchestrationV2MachineHandoffHistoryEntry,
  type MachineHandoffId,
  type ModelSelection,
  type OrchestrationV2AdoptMachineHandoffInput,
  type OrchestrationV2AdoptMachineHandoffResult,
  type OrchestrationV2MachineHandoffContext,
  type OrchestrationV2MachineHandoffManifest,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { isMachineHandoffError, MachineHandoffError } from "./MachineHandoff.ts";
import { fetchRef, findRemoteByUrl, machineHandoffAdoptedRef } from "./MachineHandoffGit.ts";
import { MachineHandoffService } from "./MachineHandoffService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** Sent as the adopted thread's first turn when the user asks it to keep going. */
export const MACHINE_HANDOFF_CONTINUE_PROMPT = "Continue where you left off.";

export interface MachineHandoffAdoptServiceShape {
  /**
   * Turns a received bundle into a thread here: verifies it, checks the work
   * out, installs the provider session and launches the thread. Adopting the
   * same handoff again returns the thread the first adopt made.
   */
  readonly adopt: (
    input: OrchestrationV2AdoptMachineHandoffInput,
  ) => Effect.Effect<OrchestrationV2AdoptMachineHandoffResult, MachineHandoffError>;
}

export class MachineHandoffAdoptService extends Context.Service<
  MachineHandoffAdoptService,
  MachineHandoffAdoptServiceShape
>()("t3/orchestration-v2/MachineHandoffAdoptService") {}

const decodeHistory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OrchestrationV2MachineHandoffHistoryEntry)),
);

const refuse = (message: string) => (cause: unknown) => new MachineHandoffError({ message, cause });

const launchCommandId = (handoffId: MachineHandoffId) =>
  CommandId.make(`machine-handoff:${handoffId}:launch`);

const make = Effect.gen(function* () {
  const bundles = yield* MachineHandoffService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const serial = yield* KeyedLock.make<MachineHandoffId>();

  /** The thread a previous adopt of this handoff already launched, if any. */
  const previousAdopt = (handoffId: MachineHandoffId) =>
    Effect.gen(function* () {
      const receipt = yield* receipts.getByCommandId(launchCommandId(handoffId));
      if (Option.isNone(receipt) || receipt.value.status !== "accepted") return null;
      const shell = yield* threads.getThreadShell(receipt.value.threadId);
      if (shell === null || shell.worktreePath === null || shell.continuedFrom == null) return null;
      return {
        threadId: shell.id,
        worktreePath: shell.worktreePath,
        context: shell.continuedFrom.context,
      } satisfies OrchestrationV2AdoptMachineHandoffResult;
    }).pipe(Effect.mapError(refuse("Could not check for an earlier adopt.")));

  /**
   * The provider instance that continues the work: the origin's own instance
   * when this machine has it, else this machine's instance of the same
   * driver. Without one the thread continues portably on `fallback`.
   */
  const chooseProvider = Effect.fn("MachineHandoffAdoptService.chooseProvider")(function* (
    manifest: OrchestrationV2MachineHandoffManifest,
    fallback: ModelSelection | null,
  ) {
    const origin = manifest.thread.modelSelection;
    const enabled: Array<{ instanceId: ProviderInstanceId; adapter: ProviderAdapterV2Shape }> = [];
    for (const instanceId of yield* adapters.list()) {
      const metadata = adapters.getMetadata
        ? yield* adapters.getMetadata(instanceId).pipe(Effect.option)
        : Option.none();
      if (Option.isSome(metadata) && !metadata.value.enabled) continue;
      const adapter = yield* adapters.get(instanceId).pipe(Effect.option);
      if (Option.isSome(adapter)) enabled.push({ instanceId, adapter: adapter.value });
    }
    const originDriver =
      manifest.native?.driver ??
      enabled.find((candidate) => candidate.instanceId === origin.instanceId)?.adapter.driver;
    const sameDriver = enabled.filter((candidate) => candidate.adapter.driver === originDriver);
    const chosen =
      sameDriver.find((candidate) => candidate.instanceId === origin.instanceId) ??
      (originDriver === undefined
        ? undefined
        : sameDriver.find(
            (candidate) => candidate.instanceId === defaultInstanceIdForDriver(originDriver),
          )) ??
      sameDriver[0];
    if (chosen === undefined) {
      const adapter =
        fallback === null
          ? undefined
          : enabled.find((candidate) => candidate.instanceId === fallback.instanceId)?.adapter;
      if (fallback === null || adapter === undefined) {
        return yield* new MachineHandoffError({
          message: `This machine has no ${originDriver ?? "matching"} provider set up. Set one up, or choose a default model for the project.`,
        });
      }
      return { modelSelection: fallback, adapter };
    }
    return {
      modelSelection: { ...origin, instanceId: chosen.instanceId },
      adapter: chosen.adapter,
    };
  });

  /**
   * Lays the published work out as a worktree whose uncommitted changes match
   * the origin's: check out the published commit, then move the branch back to
   * its base so the work is uncommitted again. A retry reuses the worktree.
   */
  const prepareWorktree = Effect.fn("MachineHandoffAdoptService.prepareWorktree")(function* (
    manifest: OrchestrationV2MachineHandoffManifest,
    repositoryRoot: string,
  ) {
    const adopted = machineHandoffAdoptedRef(manifest.handoffId);
    // A retry after a later step failed reuses the worktree it already made,
    // even if the origin has since cleaned up the published ref.
    const recorded = yield* bundles.adoptedWorkspace(manifest.handoffId);
    const { worktreePath, branch } = Option.isSome(recorded)
      ? recorded.value
      : yield* Effect.gen(function* () {
          const remote = yield* findRemoteByUrl(git, repositoryRoot, manifest.git.remoteUrl);
          if (remote === null) {
            return yield* new MachineHandoffError({
              message: `This machine's checkout has no remote for ${manifest.git.remoteUrl}.`,
            });
          }
          yield* fetchRef(git, {
            cwd: repositoryRoot,
            remote,
            ref: manifest.git.ref,
            into: adopted,
          });
          const origin = manifest.thread.originBranch;
          const taken = new Set(yield* gitWorkflow.listLocalBranchNames(repositoryRoot));
          const branch =
            origin !== null && !taken.has(origin)
              ? origin
              : `${origin ?? "handoff"}-${manifest.handoffId.slice(0, 8)}`;
          const created = yield* gitWorkflow.createWorktree({
            cwd: repositoryRoot,
            refName: adopted,
            newRefName: branch,
            path: null,
          });
          const workspace = { worktreePath: created.worktree.path, branch };
          yield* bundles.rememberAdoptedWorkspace(manifest.handoffId, workspace);
          return workspace;
        });
    yield* git.execute({
      operation: "MachineHandoff.restoreUncommitted",
      cwd: worktreePath,
      args: ["reset", "--mixed", manifest.git.baseCommit],
    });
    yield* git
      .execute({
        operation: "MachineHandoff.deleteAdoptedRef",
        cwd: repositoryRoot,
        args: ["update-ref", "-d", adopted],
        allowNonZeroExit: true,
      })
      .pipe(Effect.ignore);
    return { worktreePath, branch };
  });

  const adoptOnce = Effect.fn("MachineHandoffAdoptService.adopt")(function* (
    input: OrchestrationV2AdoptMachineHandoffInput,
  ) {
    const previous = yield* previousAdopt(input.handoffId);
    if (previous !== null) return previous;

    // Verified in full before anything touches git or the provider's home.
    const { manifest, payload } = yield* bundles.readReceived(input.handoffId);
    const nativeBytes = payload.subarray(0, manifest.native?.bytes ?? 0);
    const history = yield* decodeHistory(
      new TextDecoder().decode(payload.subarray(manifest.native?.bytes ?? 0)),
    ).pipe(Effect.mapError(refuse("The handoff's conversation is unreadable.")));

    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(refuse("Could not read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new MachineHandoffError({ message: "Project not found." })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const { modelSelection, adapter } = yield* chooseProvider(
      manifest,
      project.defaultModelSelection ?? null,
    );
    const native =
      manifest.native !== null &&
      adapter?.driver === manifest.native.driver &&
      adapter.nativeSessionTransfer !== undefined
        ? { ...manifest.native, transfer: adapter.nativeSessionTransfer }
        : null;
    const context: OrchestrationV2MachineHandoffContext = native === null ? "portable" : "native";

    const workspace = yield* prepareWorktree(manifest, project.workspaceRoot).pipe(
      Effect.mapError((cause) =>
        isMachineHandoffError(cause)
          ? cause
          : new MachineHandoffError({
              message: "Could not check out the handed-off work on this machine.",
              cause,
            }),
      ),
    );
    if (native !== null) {
      // After the worktree exists: Claude files sessions under its real path.
      yield* native.transfer
        .install({
          nativeThreadId: native.nativeThreadId,
          cwd: workspace.worktreePath,
          session: { bytes: nativeBytes, fileName: native.fileName },
        })
        .pipe(Effect.mapError(refuse("Could not install the agent's session on this machine.")));
    }

    const launched = yield* launcher
      .launch({
        commandId: launchCommandId(input.handoffId),
        threadId: manifest.targetThreadId,
        projectId: input.projectId,
        title: manifest.thread.title,
        modelSelection,
        runtimeMode: manifest.thread.runtimeMode,
        interactionMode: manifest.thread.interactionMode,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
        },
        ...(native === null
          ? {}
          : {
              importedNativeThread: {
                ref: { driver: native.driver, nativeId: native.nativeThreadId, strength: "strong" },
              },
            }),
        machineHandoff: {
          continuedFrom: {
            environmentId: manifest.originEnvironmentId,
            threadId: manifest.originThreadId,
            ...(manifest.originEnvironmentLabel === undefined
              ? {}
              : { environmentLabel: manifest.originEnvironmentLabel }),
            handoffId: input.handoffId,
            context,
            at: DateTime.formatIso(yield* DateTime.now),
          },
          history,
        },
        ...(input.continueWork
          ? {
              initialMessage: {
                text: MACHINE_HANDOFF_CONTINUE_PROMPT,
                attachments: [],
                provenance: { createdBy: "agent", creationSource: "server" },
              },
            }
          : {}),
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(refuse("Could not start the thread on this machine.")));
    yield* bundles.discardReceived(input.handoffId);
    return {
      threadId: launched.threadId,
      worktreePath: workspace.worktreePath,
      context,
    } satisfies OrchestrationV2AdoptMachineHandoffResult;
  });

  return MachineHandoffAdoptService.of({
    adopt: (input) => serial.withLock(input.handoffId, adoptOnce(input)),
  });
});

export const layer = Layer.effect(MachineHandoffAdoptService, make);
