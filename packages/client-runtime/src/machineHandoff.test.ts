import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, MachineHandoffId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  machineHandoffBanner,
  machineHandoffStatus,
  planMachineHandoffRun,
  planMachineHandoffTargets,
  type MachineHandoffEnvironment,
} from "./machineHandoff.ts";
import type { EnvironmentProject } from "./state/models.ts";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");

const project = (
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
  canonicalKey: string | null,
) =>
  ({
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity:
      canonicalKey === null
        ? null
        : {
            canonicalKey,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: canonicalKey },
            displayName: "acme/app",
          },
  }) as EnvironmentProject;

const environment = (
  overrides: Partial<MachineHandoffEnvironment> & Pick<MachineHandoffEnvironment, "projects">,
): MachineHandoffEnvironment => ({
  environmentId: desktop,
  label: "Desktop",
  connected: true,
  supportsHandoff: true,
  ...overrides,
});

describe("planMachineHandoffTargets", () => {
  const origin = project(laptop, "app-laptop", "/Users/me/code/app", "github.com/acme/app");

  it("finds the same repository by identity even at a different path", () => {
    const targets = planMachineHandoffTargets({
      originEnvironmentId: laptop,
      originProject: origin,
      environments: [
        environment({ environmentId: laptop, label: "Laptop", projects: [origin] }),
        environment({
          projects: [
            project(desktop, "same-path-other-repo", "/Users/me/code/app", "github.com/acme/web"),
            project(desktop, "app-desktop", "/home/me/src/app", "github.com/acme/app"),
          ],
        }),
      ],
    });
    expect(targets).toEqual([
      { environmentId: desktop, label: "Desktop", projectId: ProjectId.make("app-desktop") },
    ]);
  });

  it("says why a machine cannot take the thread", () => {
    const reasons = (environments: ReadonlyArray<MachineHandoffEnvironment>, from = origin) =>
      planMachineHandoffTargets({
        originEnvironmentId: laptop,
        originProject: from,
        environments,
      }).map((target) => ("unavailable" in target ? target.unavailable : "ok"));
    expect(reasons([environment({ connected: false, projects: [] })])).toEqual(["Not connected"]);
    expect(reasons([environment({ supportsHandoff: false, projects: [] })])).toEqual([
      "Update Desktop to hand off threads",
    ]);
    expect(reasons([environment({ projects: [] })])).toEqual(["acme/app isn't open there"]);
    expect(
      reasons([environment({ projects: [] })], project(laptop, "scratch", "/tmp/x", null)),
    ).toEqual(["This project has no git remote"]);
  });
});

describe("machineHandoffStatus", () => {
  const handoff = (state: "exporting" | "ready" | "failed" | "completed") => ({
    machineHandoff: {
      id: MachineHandoffId.make("h"),
      target: { environmentId: desktop, threadId: ThreadId.make("t") },
      state,
      startedAt: "2026-10-05T00:00:00.000Z",
    },
  });

  it("is elsewhere once landed and moving until then", () => {
    expect(machineHandoffStatus({})).toBeNull();
    expect(machineHandoffStatus(handoff("completed"))).toBe("elsewhere");
    for (const state of ["exporting", "ready", "failed"] as const) {
      expect(machineHandoffStatus(handoff(state))).toBe("moving");
    }
  });
});

describe("planMachineHandoffRun", () => {
  const origin = project(laptop, "app-laptop", "/Users/me/code/app", "github.com/acme/app");
  const environments = [
    environment({ environmentId: laptop, label: "Laptop", projects: [origin] }),
    environment({
      projects: [project(desktop, "app-desktop", "/home/me/src/app", "github.com/acme/app")],
    }),
  ];
  const ids = { handoffId: MachineHandoffId.make("new"), threadId: ThreadId.make("new-thread") };
  const thread = (state: "ready" | "completed") => ({
    environmentId: laptop,
    id: ThreadId.make("laptop-thread"),
    projectId: origin.id,
    machineHandoff: {
      id: MachineHandoffId.make("h1"),
      target: {
        environmentId: desktop,
        threadId: ThreadId.make("desktop-thread"),
        environmentLabel: "Desktop",
      },
      state,
      startedAt: "2026-10-05T00:00:00.000Z",
    },
  });

  it("carries a staged handoff to the project that holds the repository there", () => {
    const planned = planMachineHandoffRun({
      thread: thread("ready"),
      action: { type: "continue" },
      environments,
      ids,
    });
    expect(planned).toMatchObject({
      run: {
        handoffId: "h1",
        mode: "resume",
        origin: { environmentId: laptop, threadId: "laptop-thread" },
        target: { environmentId: desktop, threadId: "desktop-thread", projectId: "app-desktop" },
      },
    });
  });

  it("hands back by moving the other machine's thread here as a new one", () => {
    const planned = planMachineHandoffRun({
      thread: thread("completed"),
      action: { type: "hand-back" },
      environments,
      ids,
    });
    expect(planned).toMatchObject({
      run: {
        handoffId: "new",
        mode: "start",
        origin: { environmentId: desktop, threadId: "desktop-thread" },
        target: { environmentId: laptop, threadId: "new-thread", projectId: "app-laptop" },
      },
    });
  });
});

describe("machineHandoffBanner", () => {
  const record = (state: "exporting" | "ready" | "failed" | "completed", error?: string) => ({
    machineHandoff: {
      id: MachineHandoffId.make("h"),
      target: { environmentId: desktop, threadId: ThreadId.make("t"), environmentLabel: "Desktop" },
      state,
      startedAt: "2026-10-05T00:00:00.000Z",
      ...(error === undefined ? {} : { error }),
    },
  });

  it("offers Continue only where no transfer is running", () => {
    expect(machineHandoffBanner(record("ready"), null)?.actions).toEqual(["continue", "cancel"]);
    expect(
      machineHandoffBanner(record("ready"), {
        stage: "transferring",
        sentBytes: 5,
        totalBytes: 10,
      }),
    ).toMatchObject({ description: "Copying the session (50%).", actions: ["cancel"] });
  });

  it("gives every state a way back", () => {
    expect(machineHandoffBanner(record("failed", "No remote."), null)).toMatchObject({
      tone: "warning",
      description: "No remote.",
      actions: ["retry", "cancel"],
    });
    expect(machineHandoffBanner(record("completed"), null)?.actions).toEqual([
      "hand-back",
      "take-back",
    ]);
  });

  it("tells an adopted thread when only the conversation came along", () => {
    const continuedFrom = (context: "native" | "portable") => ({
      continuedFrom: {
        environmentId: laptop,
        threadId: ThreadId.make("o"),
        environmentLabel: "Laptop",
        handoffId: MachineHandoffId.make("h"),
        context,
        at: "2026-10-05T00:00:00.000Z",
      },
    });
    expect(machineHandoffBanner(continuedFrom("native"), null)?.description).toBeNull();
    expect(machineHandoffBanner(continuedFrom("portable"), null)?.title).toBe(
      "Continued from Laptop",
    );
  });
});
