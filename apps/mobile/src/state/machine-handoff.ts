import { useAtomValue } from "@effect/atom-react";
import type { MachineHandoffProgress } from "@t3tools/client-runtime/operations";
import { createMachineHandoffClient } from "@t3tools/client-runtime/state/machine-handoff";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";

export const machineHandoff = createMachineHandoffClient(connectionAtomRuntime, {
  registry: appAtomRegistry,
  threadShellAtom: environmentThreadShells.threadShellAtom,
  presentationsAtom: environmentPresentations.presentationsAtom,
  projectsAtom: environmentProjects.projectsAtom,
  randomUuid: uuidv4,
});

const NO_PROGRESS_ATOM = Atom.make<MachineHandoffProgress | null>(null).pipe(
  Atom.withLabel("mobile-machine-handoff-progress:none"),
);

/** This device's progress carrying the handoff, or null when another device carries it. */
export function useMachineHandoffProgress(handoffId: string | null): MachineHandoffProgress | null {
  return useAtomValue(
    handoffId === null ? NO_PROGRESS_ATOM : machineHandoff.progressAtom(handoffId),
  );
}
