import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2MachineHandoff,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * State rules for moving a thread to another machine. The orchestrator owns
 * events and effects; this decides what each command means for the origin
 * thread's `machineHandoff` record.
 */

/** A handoff step that could not finish; `message` is shown to the user. */
export class MachineHandoffError extends Schema.TaggedError<MachineHandoffError>()(
  "MachineHandoffError",
  {
    message: Schema.String,
    /** Worth retrying as is, such as a thread that has not finished stopping. */
    retryable: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const isMachineHandoffError = Schema.is(MachineHandoffError);

export function machineHandoffTargetLabel(handoff: Pick<OrchestrationV2MachineHandoff, "target">) {
  return handoff.target.environmentLabel ?? "another machine";
}

/** Why a thread cannot start a run here, or null when it can. */
export function machineHandoffRunRefusal(
  thread: Pick<OrchestrationV2AppThread, "machineHandoff">,
): string | null {
  const handoff = thread.machineHandoff;
  if (handoff == null) return null;
  const label = machineHandoffTargetLabel(handoff);
  return handoff.state === "completed"
    ? `This thread's work moved to ${label}.`
    : `This thread is being handed off to ${label}.`;
}

export function machineHandoffStartRefusal(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
}): string | null {
  const { thread } = input;
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    return "Only active threads can be handed off.";
  }
  if (thread.machineHandoff != null) {
    return thread.machineHandoff.state === "completed"
      ? `This thread's work already moved to ${machineHandoffTargetLabel(thread.machineHandoff)}.`
      : "This thread is already being handed off.";
  }
  if (isProviderNativeSubagentThread(thread)) {
    return "A provider subagent moves with its parent thread.";
  }
  if (input.runs.some((run) => run.status === "preparing")) {
    return "Wait for the workspace to finish preparing.";
  }
  return null;
}

type FollowUpCommand = Extract<
  OrchestrationV2Command | OrchestrationV2InternalCommand,
  {
    readonly type:
      | "thread.machine-handoff.complete"
      | "thread.machine-handoff.fail"
      | "thread.machine-handoff.retry"
      | "thread.machine-handoff.cancel"
      | "thread.machine-handoff.ready";
  }
>;

export type MachineHandoffTransition =
  | {
      readonly type: "update";
      readonly machineHandoff: OrchestrationV2MachineHandoff | null;
      /** Durable work the new state needs, keyed by the handoff it belongs to. */
      readonly enqueue?: { readonly type: "export" | "cleanup"; readonly handoffId: string };
    }
  /** Accepted without changing anything: a replayed or stale follow-up. */
  | { readonly type: "noop" }
  | { readonly type: "reject"; readonly reason: string };

/** Every follow-up after start: what it does to the current record. */
export function planMachineHandoffTransition(
  command: FollowUpCommand,
  current: OrchestrationV2MachineHandoff | null | undefined,
  now: string,
): MachineHandoffTransition {
  if (command.type === "thread.machine-handoff.cancel") {
    if (current == null) return { type: "noop" };
    return {
      type: "update",
      machineHandoff: null,
      enqueue: { type: "cleanup", handoffId: current.id },
    };
  }
  const matches = current != null && current.id === command.handoffId;
  switch (command.type) {
    case "thread.machine-handoff.ready":
      return matches && current.state === "exporting"
        ? { type: "update", machineHandoff: { ...current, state: "ready" } }
        : { type: "noop" };
    case "thread.machine-handoff.fail":
      return matches && (current.state === "exporting" || current.state === "ready")
        ? { type: "update", machineHandoff: { ...current, state: "failed", error: command.error } }
        : { type: "noop" };
    case "thread.machine-handoff.retry": {
      if (matches && current.state === "exporting") return { type: "noop" };
      if (!matches || current.state !== "failed") {
        return { type: "reject", reason: "Only a failed handoff can be retried." };
      }
      const { error: _error, ...rest } = current;
      return {
        type: "update",
        machineHandoff: { ...rest, state: "exporting" },
        enqueue: { type: "export", handoffId: current.id },
      };
    }
    case "thread.machine-handoff.complete": {
      if (matches && current.state === "completed") return { type: "noop" };
      if (!matches || current.state !== "ready") {
        return { type: "reject", reason: "Only a staged handoff can complete." };
      }
      if (command.target.environmentId !== current.target.environmentId) {
        return { type: "reject", reason: "The handoff completed on a different machine." };
      }
      const { error: _error, ...rest } = current;
      return {
        type: "update",
        machineHandoff: {
          ...rest,
          // Adopt is idempotent per handoff, so this is the thread it settled on.
          target: command.target,
          state: "completed",
          completedAt: now,
        },
        // The target already fetched the work; the published ref has done its job.
        enqueue: { type: "cleanup", handoffId: current.id },
      };
    }
  }
}

/**
 * Detach effects of one handoff share this command id, so export can prove
 * the stop no matter which command (start or retry) enqueued it.
 */
export function machineHandoffStopCommandId(handoffId: string): CommandId {
  return CommandId.make(`machine-handoff:${handoffId}:stop`);
}

/**
 * Deliveries the server or an agent made on its own: a thread that moved
 * accepts and drops them, where a user's own message is refused.
 */
export function isAutomaticMessageDelivery(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): boolean {
  return (
    command.createdBy !== "user" ||
    command.scheduledTaskId !== undefined ||
    command.notification !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.restartContinuationOfRunId !== undefined ||
    command.usageLimitContinuationOfRunId !== undefined
  );
}

/**
 * Whether the detaches a handoff enqueued prove its thread stopped here: each
 * session needs one successful detach. Unsettled ones are still stopping.
 */
export function machineHandoffStopProof(
  detaches: ReadonlyArray<{ readonly providerSessionId: string; readonly status: string }>,
): "stopped" | "stopping" | "not_stopped" {
  const bySession = new Map<string, Array<string>>();
  for (const detach of detaches) {
    bySession.set(detach.providerSessionId, [
      ...(bySession.get(detach.providerSessionId) ?? []),
      detach.status,
    ]);
  }
  let proof: "stopped" | "stopping" | "not_stopped" = "stopped";
  for (const statuses of bySession.values()) {
    if (statuses.includes("succeeded")) continue;
    if (statuses.some((status) => status === "pending" || status === "running")) {
      proof = "stopping";
      continue;
    }
    return "not_stopped";
  }
  return proof;
}
