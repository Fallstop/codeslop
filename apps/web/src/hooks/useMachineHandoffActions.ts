import { machineHandoffLabel } from "@t3tools/client-runtime/machine-handoff";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import type {
  ThreadActionMenuHandoffState,
  ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { readMachineHandoffTargets, runMachineHandoffAction } from "../state/machineHandoff";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/** The handoff part of a thread's action menu, read when the menu opens. */
export function readThreadActionMenuHandoffState(
  thread: EnvironmentThreadShell,
): ThreadActionMenuHandoffState | null {
  const targets = readMachineHandoffTargets(thread);
  const handoff = thread.machineHandoff;
  if (handoff === null && targets.length === 0) return null;
  return {
    targets: targets.map((target) => ({
      environmentId: target.environmentId,
      label: target.label,
      ...("unavailable" in target ? { unavailable: target.unavailable } : {}),
    })),
    current:
      handoff === null
        ? null
        : {
            status: handoff.state === "completed" ? "elsewhere" : "moving",
            targetLabel: machineHandoffLabel(handoff.target),
          },
  };
}

function handoffFailed(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/** Confirms taking a landed thread back, since the other machine may still be running it. */
export async function confirmTakeBack(thread: EnvironmentThreadShell): Promise<boolean> {
  const api = readLocalApi();
  if (!api) return false;
  const label = machineHandoffLabel(thread.machineHandoff?.target);
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(
      [
        `Take "${thread.title}" back to this machine?`,
        `${label} may still be running it. Anything it changed there stays there.`,
      ].join("\n"),
    ),
  );
  return confirmed._tag === "Success" && confirmed.value;
}

/**
 * Runs the handoff items of the thread action menu. Resolves true when the
 * action was a handoff action, so menus can fall through to their own cases.
 */
export function useMachineHandoffActions() {
  const cancel = useAtomCommand(threadEnvironment.cancelMachineHandoff, { reportFailure: false });

  const cancelHandoff = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const result = await cancel({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        handoffFailed(
          "Could not take the thread back",
          failure instanceof Error ? failure.message : "An error occurred.",
        );
      }
    },
    [cancel],
  );

  return useCallback(
    async (action: ThreadActionMenuId, thread: EnvironmentThreadShell): Promise<boolean> => {
      if (action.startsWith("hand-off:")) {
        const environmentId = action.slice("hand-off:".length);
        const target = readMachineHandoffTargets(thread).find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (target === undefined || "unavailable" in target) return true;
        const failure = await runMachineHandoffAction(thread, {
          type: "start",
          target,
          // A thread that was working keeps working on the other machine.
          continueWork: threadRuntimeIsActive(thread.runtime),
        });
        if (failure !== null) handoffFailed(`Could not hand off to ${target.label}`, failure);
        return true;
      }
      switch (action) {
        case "cancel-handoff":
          await cancelHandoff(thread);
          return true;
        case "take-back":
          if (await confirmTakeBack(thread)) await cancelHandoff(thread);
          return true;
        case "hand-back": {
          const failure = await runMachineHandoffAction(thread, { type: "hand-back" });
          if (failure !== null) handoffFailed("Could not hand the thread back", failure);
          return true;
        }
        default:
          return false;
      }
    },
    [cancelHandoff],
  );
}
