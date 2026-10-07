import { useAtomValue } from "@effect/atom-react";
import type {
  MachineHandoffAction,
  MachineHandoffTarget,
} from "@t3tools/client-runtime/machine-handoff";
import type { MachineHandoffProgress } from "@t3tools/client-runtime/operations";
import { createMachineHandoffClient } from "@t3tools/client-runtime/state/machine-handoff";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";

export const machineHandoff = createMachineHandoffClient(connectionAtomRuntime, {
  registry: appAtomRegistry,
  threadShellAtom: environmentThreadShells.threadShellAtom,
  presentationsAtom: environmentPresentations.presentationsAtom,
  projectsAtom: environmentProjects.projectsAtom,
  randomUuid: randomUUID,
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

export function readMachineHandoffTargets(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
): ReadonlyArray<MachineHandoffTarget> {
  return machineHandoff.targetsFor(thread, appAtomRegistry.get(machineHandoff.environmentsAtom));
}

export function runMachineHandoffAction(
  thread: EnvironmentThreadShell,
  action: MachineHandoffAction,
): Promise<string | null> {
  return machineHandoff.runAction(thread, action);
}
