/**
 * What a thread's machine handoff means for the UI, shared by web and mobile.
 */
import type {
  EnvironmentId,
  MachineHandoffId,
  OrchestrationV2MachineHandoff,
  OrchestrationV2MachineHandoffOrigin,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { MachineHandoffProgress } from "./operations/machineHandoff.ts";
import type { RunMachineHandoffInput } from "./state/machineHandoffCommands.ts";
import type { EnvironmentProject } from "./state/models.ts";
import { deriveLogicalProjectKey } from "./state/projectGrouping.ts";

interface HandoffFields {
  readonly machineHandoff?: OrchestrationV2MachineHandoff | null | undefined;
  readonly continuedFrom?: OrchestrationV2MachineHandoffOrigin | null | undefined;
}

/**
 * "elsewhere": the work landed on another machine and this thread is a record.
 * "moving": a handoff is in flight or parked with an error. Either outranks
 * approval and working, because nothing can run here meanwhile.
 */
export function machineHandoffStatus(thread: HandoffFields): "elsewhere" | "moving" | null {
  const handoff = thread.machineHandoff;
  if (handoff == null) return null;
  return handoff.state === "completed" ? "elsewhere" : "moving";
}

export function machineHandoffLabel(
  endpoint: { readonly environmentLabel?: string | undefined } | null | undefined,
): string {
  return endpoint?.environmentLabel ?? "another machine";
}

/** Why the composer cannot send here, or null when it can. */
export function machineHandoffSendBlockReason(thread: HandoffFields): string | null {
  const handoff = thread.machineHandoff;
  if (handoff == null) return null;
  const label = machineHandoffLabel(handoff.target);
  return handoff.state === "completed"
    ? `This thread continues on ${label}. Take it back to work on it here.`
    : `This thread is being handed off to ${label}.`;
}

export interface MachineHandoffEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** The server advertises `threadMachineHandoff`. */
  readonly supportsHandoff: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}

export type MachineHandoffTarget =
  | {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly projectId: ProjectId;
    }
  | {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly unavailable: string;
    };

/**
 * Every other environment the thread could move to, each with the project
 * that holds the same repository there or the reason it cannot take it. The
 * repository is matched by identity, never by path: the two checkouts usually
 * live in different directories.
 */
export function planMachineHandoffTargets(input: {
  readonly originEnvironmentId: EnvironmentId;
  readonly originProject: EnvironmentProject | null;
  readonly environments: ReadonlyArray<MachineHandoffEnvironment>;
}): ReadonlyArray<MachineHandoffTarget> {
  const identity = input.originProject?.repositoryIdentity ?? null;
  const repositoryKey =
    input.originProject === null || identity === null
      ? null
      : deriveLogicalProjectKey(input.originProject, { groupingMode: "repository" });
  return input.environments
    .filter((environment) => environment.environmentId !== input.originEnvironmentId)
    .map((environment): MachineHandoffTarget => {
      const base = { environmentId: environment.environmentId, label: environment.label };
      if (!environment.connected) return { ...base, unavailable: "Not connected" };
      if (!environment.supportsHandoff) {
        return { ...base, unavailable: `Update ${environment.label} to hand off threads` };
      }
      if (repositoryKey === null) {
        return { ...base, unavailable: "This project has no git remote" };
      }
      const project = environment.projects.find(
        (candidate) =>
          candidate.repositoryIdentity != null &&
          deriveLogicalProjectKey(candidate, { groupingMode: "repository" }) === repositoryKey,
      );
      return project === undefined
        ? { ...base, unavailable: `${identity?.displayName ?? "This repository"} isn't open there` }
        : { ...base, projectId: project.id };
    });
}

export type MachineHandoffAction =
  | {
      readonly type: "start";
      readonly target: Extract<MachineHandoffTarget, { readonly projectId: ProjectId }>;
      readonly continueWork: boolean;
    }
  /** Carry a staged handoff from this client. */
  | { readonly type: "continue" }
  | { readonly type: "retry" }
  /** Bring the work back from the machine it moved to, as a new thread here. */
  | { readonly type: "hand-back" };

/**
 * Turns a user's action on a thread into the transfer to run, or the reason
 * it cannot run from here. `ids` are used only when the action starts a new
 * handoff.
 */
export function planMachineHandoffRun(input: {
  readonly thread: HandoffFields & {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
  };
  readonly action: MachineHandoffAction;
  readonly environments: ReadonlyArray<MachineHandoffEnvironment>;
  readonly ids: { readonly handoffId: MachineHandoffId; readonly threadId: ThreadId };
}): { readonly run: RunMachineHandoffInput } | { readonly unavailable: string } {
  const { thread, action } = input;
  const here = { environmentId: thread.environmentId, threadId: thread.id };
  if (action.type === "start") {
    return {
      run: {
        handoffId: input.ids.handoffId,
        origin: here,
        target: {
          environmentId: action.target.environmentId,
          threadId: input.ids.threadId,
          environmentLabel: action.target.label,
          projectId: action.target.projectId,
        },
        continueWork: action.continueWork,
        mode: "start",
      },
    };
  }
  const handoff = thread.machineHandoff;
  if (handoff == null) return { unavailable: "This thread is not being handed off." };
  const environment = (environmentId: EnvironmentId) =>
    input.environments.find((candidate) => candidate.environmentId === environmentId);

  if (action.type === "hand-back") {
    const other = environment(handoff.target.environmentId);
    const ownEnvironment = environment(thread.environmentId);
    if (handoff.state !== "completed") return { unavailable: "The handoff has not landed yet." };
    if (other === undefined || !other.connected) return { unavailable: "Not connected" };
    if (!other.supportsHandoff || ownEnvironment?.supportsHandoff !== true) {
      return { unavailable: `Update ${other.label} to hand off threads` };
    }
    return {
      run: {
        handoffId: input.ids.handoffId,
        origin: { environmentId: handoff.target.environmentId, threadId: handoff.target.threadId },
        target: {
          environmentId: thread.environmentId,
          threadId: input.ids.threadId,
          environmentLabel: ownEnvironment.label,
          projectId: thread.projectId,
        },
        continueWork: false,
        mode: "start",
      },
    };
  }

  const project =
    environment(thread.environmentId)?.projects.find(
      (candidate) => candidate.id === thread.projectId,
    ) ?? null;
  const target = planMachineHandoffTargets({
    originEnvironmentId: thread.environmentId,
    originProject: project,
    environments: input.environments,
  }).find((candidate) => candidate.environmentId === handoff.target.environmentId);
  if (target === undefined) return { unavailable: "Not connected" };
  if ("unavailable" in target) return { unavailable: target.unavailable };
  return {
    run: {
      handoffId: handoff.id,
      origin: here,
      target: { ...handoff.target, projectId: target.projectId },
      continueWork: false,
      mode: action.type === "retry" ? "retry" : "resume",
    },
  };
}

export type MachineHandoffBannerAction =
  | "cancel"
  | "continue"
  | "retry"
  | "hand-back"
  | "take-back";

export interface MachineHandoffBanner {
  readonly tone: "info" | "warning";
  readonly title: string;
  readonly description: string | null;
  readonly actions: ReadonlyArray<MachineHandoffBannerAction>;
}

function describeProgress(progress: MachineHandoffProgress): string {
  switch (progress.stage) {
    case "staging":
      return "Stopping the agent here and packing up the work.";
    case "transferring":
      return `Copying the session (${Math.floor((progress.sentBytes / Math.max(1, progress.totalBytes)) * 100)}%).`;
    case "adopting":
      return "Checking out the work on the other machine.";
  }
}

/**
 * What the composer banner says about a thread's handoff. `progress` is this
 * client's own transfer, if it is the one carrying the handoff.
 */
export function machineHandoffBanner(
  thread: HandoffFields,
  progress: MachineHandoffProgress | null,
): MachineHandoffBanner | null {
  const handoff = thread.machineHandoff;
  if (handoff == null) {
    const origin = thread.continuedFrom;
    if (origin == null) return null;
    return {
      tone: "info",
      title: `Continued from ${machineHandoffLabel(origin)}`,
      description:
        origin.context === "portable"
          ? "The agent's own session could not move, so it picks up from the conversation."
          : null,
      actions: [],
    };
  }
  const label = machineHandoffLabel(handoff.target);
  switch (handoff.state) {
    case "exporting":
    case "ready":
      if (progress !== null || handoff.state === "exporting") {
        return {
          tone: "info",
          title: `Handing off to ${label}…`,
          description: describeProgress(progress ?? { stage: "staging" }),
          actions: ["cancel"],
        };
      }
      return {
        tone: "info",
        title: `Ready to move to ${label}`,
        description: "The work is packed up. Continue to finish moving it from this device.",
        actions: ["continue", "cancel"],
      };
    case "failed":
      return {
        tone: "warning",
        title: `Handoff to ${label} failed`,
        description: handoff.error ?? null,
        actions: ["retry", "cancel"],
      };
    case "completed":
      return {
        tone: "info",
        title: `Continued on ${label}`,
        description: "This thread is a record here. Hand it back, or take it back to keep working.",
        actions: ["hand-back", "take-back"],
      };
  }
}
