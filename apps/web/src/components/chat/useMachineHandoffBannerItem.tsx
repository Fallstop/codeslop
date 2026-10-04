import {
  machineHandoffBanner,
  type MachineHandoffBannerAction,
} from "@t3tools/client-runtime/machine-handoff";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ArrowRightLeftIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useMachineHandoffActions } from "../../hooks/useMachineHandoffActions";
import { runMachineHandoffAction, useMachineHandoffProgress } from "../../state/machineHandoff";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const ACTION_LABELS: Record<MachineHandoffBannerAction, string> = {
  cancel: "Cancel",
  continue: "Continue",
  retry: "Retry",
  "hand-back": "Hand back",
  "take-back": "Take back",
};

/** The composer banner for a thread that is moving, moved, or arrived from another machine. */
export function useMachineHandoffBannerItem(
  thread: EnvironmentThreadShell | null,
): ComposerBannerStackItem | null {
  const progress = useMachineHandoffProgress(thread?.machineHandoff?.id ?? null);
  const handleMenuAction = useMachineHandoffActions();
  const [busy, setBusy] = useState(false);
  // "Continued from" is an arrival note; dismissing it lasts for the session.
  const [dismissedArrivals, setDismissedArrivals] = useState<ReadonlySet<string>>(new Set());

  const run = useCallback(
    (action: MachineHandoffBannerAction) => {
      if (thread === null) return;
      setBusy(true);
      void (async () => {
        if (action === "continue" || action === "retry") {
          const failure = await runMachineHandoffAction(thread, { type: action });
          if (failure !== null) {
            toastManager.add(
              stackedThreadToast({ type: "error", title: "Handoff failed", description: failure }),
            );
          }
        } else {
          await handleMenuAction(
            action === "cancel"
              ? "cancel-handoff"
              : action === "hand-back"
                ? "hand-back"
                : "take-back",
            thread,
          );
        }
      })().finally(() => setBusy(false));
    },
    [handleMenuAction, thread],
  );

  return useMemo(() => {
    if (thread === null) return null;
    const banner = machineHandoffBanner(thread, progress);
    if (banner === null) return null;
    const arrivalKey =
      thread.machineHandoff === null && thread.continuedFrom !== null
        ? `${thread.id}:${thread.continuedFrom.handoffId}`
        : null;
    if (arrivalKey !== null && dismissedArrivals.has(arrivalKey)) return null;
    return {
      id: `machine-handoff:${thread.id}`,
      variant: banner.tone,
      icon: <ArrowRightLeftIcon />,
      title: banner.title,
      ...(banner.description === null ? {} : { description: banner.description }),
      ...(banner.actions.length === 0
        ? {}
        : {
            actions: (
              <>
                {banner.actions.map((action) => (
                  <Button
                    key={action}
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => run(action)}
                  >
                    {ACTION_LABELS[action]}
                  </Button>
                ))}
              </>
            ),
          }),
      ...(arrivalKey === null
        ? {}
        : {
            dismissLabel: "Dismiss handoff note",
            onDismiss: () => setDismissedArrivals((current) => new Set([...current, arrivalKey])),
          }),
    };
  }, [busy, dismissedArrivals, progress, run, thread]);
}
