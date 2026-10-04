import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import {
  machineHandoffLabel,
  type MachineHandoffAction,
} from "@t3tools/client-runtime/machine-handoff";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { machineHandoff } from "../../state/machine-handoff";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const HAND_OFF_PREFIX = "hand-off:";

function confirm(input: {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly onConfirm: () => void;
}) {
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(input.title, input.message, [
      { text: "Cancel", style: "cancel" },
      { text: input.confirmText, onPress: input.onConfirm },
    ]);
    return;
  }
  showConfirmDialog(input);
}

/**
 * Hand off, cancel, hand back and take back for one thread, as menu items and
 * the handler for them. Matches the web thread menu.
 */
export function useMachineHandoffActions(thread: EnvironmentThreadShell) {
  const environments = useAtomValue(machineHandoff.environmentsAtom);
  const cancel = useAtomCommand(threadEnvironment.cancelMachineHandoff, { reportFailure: false });

  const menuItems = useMemo<MenuAction[]>(() => {
    const handoff = thread.machineHandoff;
    if (handoff !== null) {
      return handoff.state === "completed"
        ? [
            {
              id: "hand-back",
              title: `Hand back from ${machineHandoffLabel(handoff.target)}`,
              image: "arrow.left.arrow.right",
            },
            { id: "take-back", title: "Take back here", image: "arrow.uturn.backward" },
          ]
        : [{ id: "cancel-handoff", title: "Cancel handoff", image: "xmark" }];
    }
    const targets = machineHandoff.targetsFor(thread, environments);
    if (targets.length === 0) return [];
    return [
      {
        id: "hand-off",
        title: "Hand off to",
        image: "arrow.left.arrow.right",
        subactions: targets.map((target) => ({
          id: `${HAND_OFF_PREFIX}${target.environmentId}`,
          title: target.label,
          ...("unavailable" in target
            ? { subtitle: target.unavailable, attributes: { disabled: true } }
            : {}),
        })),
      },
    ];
  }, [environments, thread]);

  const run = useCallback(
    async (action: MachineHandoffAction, failureTitle: string) => {
      const failure = await machineHandoff.runAction(thread, action);
      if (failure !== null) Alert.alert(failureTitle, failure);
    },
    [thread],
  );

  const cancelHandoff = useCallback(async () => {
    const result = await cancel({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    });
    if (result._tag === "Failure") {
      Alert.alert(
        "Could not take the thread back",
        "Try again when the thread's machine is reachable.",
      );
    }
  }, [cancel, thread]);

  const takeBack = useCallback(() => {
    confirm({
      title: "Take this thread back?",
      message: `${machineHandoffLabel(thread.machineHandoff?.target)} may still be running it. Anything it changed there stays there.`,
      confirmText: "Take back",
      onConfirm: () => void cancelHandoff(),
    });
  }, [cancelHandoff, thread.machineHandoff]);

  /** Runs a handoff menu event. Returns false for events that are not handoff actions. */
  const handleMenuEvent = useCallback(
    (event: string): boolean => {
      if (event.startsWith(HAND_OFF_PREFIX)) {
        const environmentId = event.slice(HAND_OFF_PREFIX.length);
        const target = machineHandoff
          .targetsFor(thread, environments)
          .find((candidate) => candidate.environmentId === environmentId);
        if (target !== undefined && !("unavailable" in target)) {
          void run(
            {
              type: "start",
              target,
              continueWork: threadRuntimeIsActive(thread.runtime),
            },
            `Could not hand off to ${target.label}`,
          );
        }
        return true;
      }
      switch (event) {
        case "cancel-handoff":
          void cancelHandoff();
          return true;
        case "take-back":
          takeBack();
          return true;
        case "hand-back":
          void run({ type: "hand-back" }, "Could not hand the thread back");
          return true;
        default:
          return false;
      }
    },
    [cancelHandoff, environments, run, takeBack, thread],
  );

  return { menuItems, handleMenuEvent, run, cancelHandoff, takeBack };
}
