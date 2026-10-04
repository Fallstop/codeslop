import { useAtomValue } from "@effect/atom-react";
import {
  planMachineHandoffRun,
  planMachineHandoffTargets,
  type MachineHandoffAction,
  type MachineHandoffEnvironment,
  type MachineHandoffTarget,
} from "@t3tools/client-runtime/machine-handoff";
import type { MachineHandoffProgress } from "@t3tools/client-runtime/operations";
import { createMachineHandoffCommandAtoms } from "@t3tools/client-runtime/state/machine-handoff";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MachineHandoffId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { newThreadId, randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";

export const machineHandoff = createMachineHandoffCommandAtoms(connectionAtomRuntime, {
  threadShellAtom: environmentThreadShells.threadShellAtom,
});

const NO_PROGRESS_ATOM = Atom.make<MachineHandoffProgress | null>(null).pipe(
  Atom.withLabel("web-machine-handoff-progress:none"),
);

/** This client's progress carrying the handoff, or null when another client carries it. */
export function useMachineHandoffProgress(handoffId: string | null): MachineHandoffProgress | null {
  return useAtomValue(
    handoffId === null ? NO_PROGRESS_ATOM : machineHandoff.progressAtom(handoffId),
  );
}

export function readMachineHandoffEnvironments(): ReadonlyArray<MachineHandoffEnvironment> {
  const projects = appAtomRegistry.get(environmentProjects.projectsAtom);
  return [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].map(
    ([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
      connected: presentation.connection.phase === "connected",
      supportsHandoff:
        presentation.serverConfig?.environment.capabilities.threadMachineHandoff === true,
      projects: projects.filter((project) => project.environmentId === environmentId),
    }),
  );
}

export function readMachineHandoffTargets(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
): ReadonlyArray<MachineHandoffTarget> {
  const environments = readMachineHandoffEnvironments();
  if (
    environments.find((environment) => environment.environmentId === thread.environmentId)
      ?.supportsHandoff !== true
  ) {
    return [];
  }
  return planMachineHandoffTargets({
    originEnvironmentId: thread.environmentId,
    originProject:
      appAtomRegistry
        .get(environmentProjects.projectsAtom)
        .find(
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        ) ?? null,
    environments,
  });
}

/** Runs a handoff action to completion. Resolves with a failure message, or null. */
export async function runMachineHandoffAction(
  thread: EnvironmentThreadShell,
  action: MachineHandoffAction,
): Promise<string | null> {
  const planned = planMachineHandoffRun({
    thread,
    action,
    environments: readMachineHandoffEnvironments(),
    ids: { handoffId: MachineHandoffId.make(randomUUID()), threadId: newThreadId() },
  });
  if ("unavailable" in planned) return planned.unavailable;
  const result = await runAtomCommand(appAtomRegistry, machineHandoff.run, planned.run, {
    reportFailure: false,
  });
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "The handoff failed.";
}
