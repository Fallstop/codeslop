import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useEffect, useMemo, useRef } from "react";

import { randomHex } from "~/lib/utils";
import { resolveHandoffTransferPlan } from "./threadHandoffCourier.logic";
import { readProject, useProjects, useThreadShells } from "./state/entities";
import { handoffCommands, threadEnvironment } from "./state/threads";
import { useAtomCommand } from "./state/use-atom-command";

/**
 * Carries staged handoffs across.
 *
 * The origin freezes a thread and stages its bundle on its own, but only a
 * client is connected to both machines, so the last leg runs here. This watches
 * every thread on every environment for one whose handoff has reached "staged"
 * and drives the transfer.
 *
 * Level-triggered, not edge-triggered: a tab opened after the freeze must pick
 * up a handoff already waiting, so the ref below — not a state transition — is
 * what keeps a bundle from being couriered twice. That guard is per-tab; the
 * command itself is singleFlight on the handoff id, and the target's checksum
 * and worktree creation are what stop a genuine double-adopt.
 */
export function ThreadHandoffCourier() {
  const threads = useThreadShells();
  const projects = useProjects();
  const runHandoff = useAtomCommand(handoffCommands.run, { label: "handoff:courier" });
  const failHandoff = useAtomCommand(threadEnvironment.failHandoff, {
    label: "handoff:courier-unavailable",
  });
  const attemptedRef = useRef<Set<string>>(new Set());

  // Depending on the whole thread array would re-run this on every shell
  // snapshot from every environment; the staged ids are what actually matter.
  const stagedKey = useMemo(
    () =>
      threads
        .filter((thread) => thread.handoff?.stage === "staged")
        .map((thread) => `${thread.environmentId}:${thread.handoff?.handoffId ?? ""}`)
        .toSorted()
        .join(","),
    [threads],
  );

  useEffect(() => {
    if (stagedKey.length === 0) return;

    for (const thread of threads) {
      const handoff = thread.handoff;
      if (!handoff || handoff.stage !== "staged") continue;
      if (attemptedRef.current.has(handoff.handoffId)) continue;
      attemptedRef.current.add(handoff.handoffId);

      const originProject = readProject({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      });
      const plan = resolveHandoffTransferPlan({
        thread,
        originProject,
        projects,
        provider: thread.session?.providerName ?? null,
      });

      if (plan._tag === "unavailable") {
        // Park it with the reason rather than attempting a transfer that cannot
        // land. The thread stays frozen and the banner offers retry or take-back.
        void failHandoff({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            handoffId: handoff.handoffId,
            stage: "adopting",
            error: plan.reason,
          },
        });
        continue;
      }

      void runHandoff({
        handoffId: handoff.handoffId,
        origin: { environmentId: thread.environmentId, threadId: thread.id },
        target: handoff.target,
        repositoryPath: plan.repositoryPath,
        branch: buildTemporaryWorktreeBranchName(randomHex),
        createInput: plan.createInput,
        continuedFrom: {
          environmentId: thread.environmentId,
          threadId: thread.id,
          at: new Date().toISOString(),
          threadTitle: thread.title,
        },
        firstTurn: null,
      });
    }
    // stagedKey is the real dependency; the rest is read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedKey]);

  return null;
}
