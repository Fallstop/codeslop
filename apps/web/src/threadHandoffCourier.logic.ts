import {
  defaultInstanceIdForDriver,
  type ProjectId,
  type ProviderDriverKind,
} from "@t3tools/contracts";

import { deriveLogicalProjectKey } from "./logicalProject";
import type { Project, SidebarThreadSummary } from "./types";

export type HandoffTransferPlan =
  | {
      readonly _tag: "ready";
      readonly repositoryPath: string;
      readonly targetProjectId: ProjectId;
      readonly createInput: {
        readonly projectId: ProjectId;
        readonly title: string;
        readonly modelSelection: SidebarThreadSummary["modelSelection"];
        readonly runtimeMode: SidebarThreadSummary["runtimeMode"];
        readonly interactionMode: SidebarThreadSummary["interactionMode"];
        readonly branch: string | null;
      };
    }
  | { readonly _tag: "unavailable"; readonly reason: string };

/**
 * Match a thread's project to its copy on the target machine.
 *
 * Repository identity, never a path: the same repo lives at different paths on
 * different machines, and `canonicalKey` is the normalized remote URL both
 * sides agree on. Grouping mode is pinned to "repository" rather than read from
 * settings — a display preference must not decide whether a handoff can land.
 */
export function resolveHandoffTransferPlan(input: {
  readonly thread: SidebarThreadSummary;
  readonly originProject: Project | null;
  readonly projects: ReadonlyArray<Project>;
  readonly provider: string | null;
}): HandoffTransferPlan {
  const handoff = input.thread.handoff;
  if (!handoff) {
    return { _tag: "unavailable", reason: "This thread is not being handed off." };
  }
  if (!input.originProject) {
    return { _tag: "unavailable", reason: "This thread's project is no longer available." };
  }

  const originKey = deriveLogicalProjectKey(input.originProject, { groupingMode: "repository" });
  const match = input.projects.find(
    (candidate) =>
      candidate.environmentId === handoff.target.environmentId &&
      deriveLogicalProjectKey(candidate, { groupingMode: "repository" }) === originKey,
  );
  if (!match) {
    const label = handoff.target.environmentLabel ?? "that machine";
    return {
      _tag: "unavailable",
      // The most likely real failure: the target is reachable but does not hold
      // this repository, so say that rather than a generic error.
      reason: `${label} does not have this repository open as a project.`,
    };
  }

  // The provider instance is environment-scoped, and adopt seeds the target's
  // session row under the default instance for the driver — so the continuation
  // thread has to name that one, not whichever instance the origin used.
  const driver = (input.provider ?? input.thread.modelSelection.instanceId) as ProviderDriverKind;
  const modelSelection = {
    ...input.thread.modelSelection,
    instanceId: defaultInstanceIdForDriver(driver),
  };

  return {
    _tag: "ready",
    repositoryPath: match.repositoryIdentity?.rootPath ?? match.workspaceRoot,
    targetProjectId: match.id,
    createInput: {
      projectId: match.id,
      title: input.thread.title,
      modelSelection,
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      // The target lays out its own worktree, so it names its own branch.
      branch: null,
    },
  };
}
