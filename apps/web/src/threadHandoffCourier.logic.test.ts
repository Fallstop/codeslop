import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  HandoffId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { resolveHandoffTransferPlan } from "./threadHandoffCourier.logic";
import type { Project, SidebarThreadSummary } from "./types";

const ORIGIN_ENV = EnvironmentId.make("env-laptop");
const TARGET_ENV = EnvironmentId.make("env-desktop");

const project = (input: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly canonicalKey: string | null;
  readonly rootPath?: string;
}): Project =>
  ({
    environmentId: input.environmentId,
    id: ProjectId.make(input.id),
    title: input.id,
    workspaceRoot: `/${input.id}`,
    repositoryIdentity:
      input.canonicalKey === null
        ? null
        : {
            canonicalKey: input.canonicalKey,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@x:y.git" },
            ...(input.rootPath !== undefined ? { rootPath: input.rootPath } : {}),
          },
  }) as unknown as Project;

const thread = (): SidebarThreadSummary =>
  ({
    environmentId: ORIGIN_ENV,
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("origin-project"),
    title: "Ship the parser",
    modelSelection: { instanceId: ProviderInstanceId.make("claude-secondary"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    handoff: {
      handoffId: HandoffId.make("handoff-1"),
      target: {
        environmentId: TARGET_ENV,
        threadId: ThreadId.make("thread-2"),
        at: "2026-08-22T00:00:00.000Z",
        environmentLabel: "Studio PC",
      },
      stage: "staged",
      startedAt: "2026-08-22T00:00:00.000Z",
    },
  }) as unknown as SidebarThreadSummary;

describe("resolveHandoffTransferPlan", () => {
  it("matches the target project by repository identity, not by path", () => {
    const plan = resolveHandoffTransferPlan({
      thread: thread(),
      originProject: project({
        environmentId: ORIGIN_ENV,
        id: "origin-project",
        canonicalKey: "github.com/acme/app",
      }),
      // Same repo, different path on the other machine — which is the norm.
      projects: [
        project({
          environmentId: TARGET_ENV,
          id: "target-project",
          canonicalKey: "github.com/acme/app",
          rootPath: "/elsewhere/app",
        }),
      ],
      provider: "claudeAgent",
    });

    expect(plan._tag).toBe("ready");
    if (plan._tag !== "ready") return;
    expect(plan.repositoryPath).toBe("/elsewhere/app");
    expect(plan.createInput.projectId).toBe("target-project");
    expect(plan.createInput.title).toBe("Ship the parser");
    // The target names its own worktree branch.
    expect(plan.createInput.branch).toBeNull();
  });

  it("rebuilds the model selection against the target's default instance", () => {
    // Adopt seeds the target's session row under the default instance for the
    // driver, so carrying the origin's instance id would point the thread at a
    // provider instance that may not exist there.
    const plan = resolveHandoffTransferPlan({
      thread: thread(),
      originProject: project({
        environmentId: ORIGIN_ENV,
        id: "origin-project",
        canonicalKey: "github.com/acme/app",
      }),
      projects: [
        project({
          environmentId: TARGET_ENV,
          id: "target-project",
          canonicalKey: "github.com/acme/app",
        }),
      ],
      provider: "claudeAgent",
    });
    if (plan._tag !== "ready") throw new Error("expected a ready plan");
    expect(plan.createInput.modelSelection.instanceId).toBe("claudeAgent");
    expect(plan.createInput.modelSelection.model).toBe("opus");
  });

  it("refuses when the target does not hold the repository", () => {
    const plan = resolveHandoffTransferPlan({
      thread: thread(),
      originProject: project({
        environmentId: ORIGIN_ENV,
        id: "origin-project",
        canonicalKey: "github.com/acme/app",
      }),
      // The target is reachable but has a different repo open.
      projects: [
        project({
          environmentId: TARGET_ENV,
          id: "other",
          canonicalKey: "github.com/acme/unrelated",
        }),
      ],
      provider: "claudeAgent",
    });
    expect(plan._tag).toBe("unavailable");
    if (plan._tag !== "unavailable") return;
    expect(plan.reason).toContain("Studio PC");
    expect(plan.reason).toContain("does not have this repository");
  });

  it("refuses rather than matching a project on the wrong machine", () => {
    // A copy of the repo on a THIRD environment must not satisfy the match.
    const plan = resolveHandoffTransferPlan({
      thread: thread(),
      originProject: project({
        environmentId: ORIGIN_ENV,
        id: "origin-project",
        canonicalKey: "github.com/acme/app",
      }),
      projects: [
        project({
          environmentId: EnvironmentId.make("env-other"),
          id: "elsewhere",
          canonicalKey: "github.com/acme/app",
        }),
      ],
      provider: "claudeAgent",
    });
    expect(plan._tag).toBe("unavailable");
  });

  it("refuses when the origin project is gone", () => {
    const plan = resolveHandoffTransferPlan({
      thread: thread(),
      originProject: null,
      projects: [],
      provider: "claudeAgent",
    });
    expect(plan._tag).toBe("unavailable");
  });
});
