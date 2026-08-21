import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { orchestrationEnvironment } from "~/state/orchestration";

/**
 * "Background work" tells you something outlived the turn but not what. The
 * server's liveness registry knows the task ids holding the thread open; this
 * asks for them on demand (never on the shell broadcast) so a banner with no
 * agents in the roster is still explainable — and a stuck row is visible by
 * its age.
 */
export function BackgroundWorkDetails({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost" aria-label="Show what background work is running" />
        }
      >
        Details
      </PopoverTrigger>
      {/* Base UI unmounts the popup when closed, so the fetch only runs on open. */}
      <PopoverPopup side="top" align="end" className="w-80" viewportClassName="py-2">
        <BackgroundWorkTaskList environmentId={environmentId} threadId={threadId} />
      </PopoverPopup>
    </Popover>
  );
}

function BackgroundWorkTaskList({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.threadBackgroundTasks({ environmentId, input: { threadId } }),
  );

  if (result._tag === "Failure") {
    return <p className="text-xs text-destructive-foreground">Could not load background work.</p>;
  }
  if (result._tag !== "Success") {
    return <p className="text-muted-foreground text-xs">Loading…</p>;
  }

  const { liveness, tasks } = result.value;
  if (tasks.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {liveness === null
          ? "Nothing is running. The banner is stale — reload to clear it."
          : "The server reports live work but has no task detail for it."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[.65rem] text-muted-foreground uppercase tracking-wide">
        {tasks.length} live {tasks.length === 1 ? "task" : "tasks"}
      </p>
      {tasks.map((task) => (
        <div key={task.taskId} className="flex flex-col gap-0.5 border-border/50 border-t pt-1.5">
          <span className="truncate text-foreground text-xs">
            {task.description ?? task.taskType ?? "Untitled task"}
          </span>
          <span className="truncate font-mono text-[.65rem] text-muted-foreground">
            {[
              task.kind,
              task.taskType,
              task.status,
              task.agentId === undefined ? undefined : `in ${task.agentId}`,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </span>
          <span className="truncate font-mono text-[.65rem] text-muted-foreground/70">
            {task.taskId}
            {task.startedAt === undefined ? "" : ` · started ${formatAge(task.startedAt)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Coarse age; the popup is read once on open, so it never needs to tick. */
function formatAge(iso: string): string {
  const elapsedMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
