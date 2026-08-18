import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  SendHorizonalIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { deriveWorkLogEntries } from "~/session-logic";
import { mergeSideChatTimeline, type SideChatRow } from "~/sideChat";
import { useThreadActivities, useThreadMessages, useThreadShell } from "~/state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface SideChatPanelProps {
  environmentId: EnvironmentId;
  parentTitle: string;
  sideChats: ReadonlyArray<OrchestrationThreadShell>;
  openThreadId: ThreadId | null;
  cwd: string | undefined;
  /** Null while the parent thread has no model selected yet. */
  canStart: boolean;
  onOpen: (threadId: ThreadId) => void;
  onShowList: () => void;
  onStartNew: () => void;
  onSend: (threadId: ThreadId, text: string) => void;
  onInterrupt: (threadId: ThreadId) => void;
  onDelete: (threadId: ThreadId) => void;
  onOpenAsThread: (threadId: ThreadId) => void;
  className?: string;
}

function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** A tool row: the visible evidence that the side chat actually ran something. */
const WorkRow = memo(function WorkRow({ row }: { row: Extract<SideChatRow, { kind: "work" }> }) {
  const { entry } = row;
  const command = entry.command ?? entry.rawCommand;
  const isError = entry.tone === "error";

  return (
    <li className="flex gap-2">
      <TerminalIcon
        className={cn(
          "mt-0.5 size-3 shrink-0",
          isError ? "text-destructive-foreground" : "text-muted-foreground/70",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-[11px]",
            isError ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {entry.toolTitle ?? entry.label}
        </p>
        {command ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground/70">{command}</p>
        ) : null}
      </div>
    </li>
  );
});

const MessageRow = memo(function MessageRow({
  row,
  cwd,
  threadRef,
}: {
  row: Extract<SideChatRow, { kind: "message" }>;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const { message } = row;
  if (message.role === "user") {
    return (
      <li className="flex gap-2">
        <span className="mt-px shrink-0 text-[11px] font-medium text-muted-foreground/70">You</span>
        <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap text-foreground/90">
          {message.text}
        </p>
      </li>
    );
  }
  if (message.text.trim().length === 0) {
    return null;
  }
  return (
    <li className="flex gap-2">
      <span className="mt-px shrink-0 text-[11px] font-medium text-muted-foreground/70">Side</span>
      <div className="min-w-0 flex-1">
        <ChatMarkdown
          text={message.text}
          cwd={cwd}
          threadRef={threadRef}
          lineBreaks
          className="text-xs"
        />
      </div>
    </li>
  );
});

function SideChatConversation({
  environmentId,
  threadId,
  cwd,
  onSend,
  onInterrupt,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}) {
  const threadRef = useMemo<ScopedThreadRef>(
    () => ({ environmentId, threadId }),
    [environmentId, threadId],
  );
  const messages = useThreadMessages(threadRef);
  const activities = useThreadActivities(threadRef);
  const shell = useThreadShell(threadRef);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const workEntries = useMemo(() => deriveWorkLogEntries(activities), [activities]);
  const rows = useMemo(() => mergeSideChatTimeline(messages, workEntries), [messages, workEntries]);
  const isWorking = shell?.latestTurn?.state === "running";

  // Follow the live edge. A side chat is short and read top-to-bottom, so it
  // pins unconditionally rather than tracking whether the user scrolled away.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [rows.length, isWorking]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    onSend(text);
  }, [draft, onSend]);

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        <ul className="flex flex-col gap-2">
          {rows.map((row) =>
            row.kind === "work" ? (
              <WorkRow key={row.id} row={row} />
            ) : (
              <MessageRow key={row.id} row={row} cwd={cwd} threadRef={threadRef} />
            ),
          )}
        </ul>
        {isWorking ? (
          <p className="mt-2 flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Working — the main thread is untouched.
          </p>
        ) : null}
      </div>

      <div className="flex items-end gap-1.5 border-t border-border/60 p-2">
        <Textarea
          value={draft}
          size="sm"
          rows={1}
          aria-label="Message the side chat"
          placeholder="Ask a follow-up…"
          className="min-h-8 flex-1 resize-none border-0 bg-background shadow-none ring-0"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              submit();
            }
          }}
        />
        {isWorking ? (
          <Button size="xs" variant="outline" onClick={onInterrupt} aria-label="Stop the side chat">
            <SquareIcon />
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={draft.trim().length === 0}
            onClick={submit}
            aria-label="Send to the side chat"
          >
            <SendHorizonalIcon />
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * Side chats: full agent sessions opened from a thread, living in the panel.
 *
 * They get the panel rather than a strip above the composer because they are
 * chats and not lookups — they run commands, take several turns, and are worth
 * reading back. The strip this replaced could only ever show one answer.
 *
 * Approvals, diffs and the model picker are deliberately not rebuilt here.
 * A side chat is an ordinary thread, so "Open as thread" hands it to the main
 * view where all of that already works, instead of growing a second copy of it.
 */
export const SideChatPanel = memo(function SideChatPanel({
  environmentId,
  parentTitle,
  sideChats,
  openThreadId,
  cwd,
  canStart,
  onOpen,
  onShowList,
  onStartNew,
  onSend,
  onInterrupt,
  onDelete,
  onOpenAsThread,
  className,
}: SideChatPanelProps) {
  const now = Date.now();
  const open = openThreadId ? (sideChats.find((chat) => chat.id === openThreadId) ?? null) : null;

  if (open) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        <header className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
          <Button
            size="xs"
            variant="ghost"
            className="size-5 shrink-0 p-0 text-muted-foreground"
            onClick={onShowList}
            aria-label="Back to side chats"
          >
            <ArrowLeftIcon />
          </Button>
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {open.title}
          </p>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => onOpenAsThread(open.id)}
                  aria-label="Open as a full thread"
                >
                  <ExternalLinkIcon />
                </Button>
              }
            />
            <TooltipPopup className="max-w-64">
              Open as a full thread, where approvals, diffs and the model picker work.
            </TooltipPopup>
          </Tooltip>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => onDelete(open.id)}
            aria-label={`Delete side chat ${open.title}`}
          >
            <Trash2Icon />
          </Button>
        </header>
        <SideChatConversation
          environmentId={environmentId}
          threadId={open.id}
          cwd={cwd}
          onSend={(text) => onSend(open.id, text)}
          onInterrupt={() => onInterrupt(open.id)}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Side chats · {parentTitle}
        </p>
        <Button size="xs" variant="outline" onClick={onStartNew} disabled={!canStart}>
          <PlusIcon />
          New
        </Button>
      </header>

      {sideChats.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <MessageCircleQuestionIcon
            className="size-5 text-muted-foreground/60"
            aria-hidden="true"
          />
          <p className="text-xs text-muted-foreground">No side chats on this thread yet.</p>
          <p className="max-w-64 text-[11px] text-muted-foreground/70">
            Type <code className="font-mono">/btw</code> in the composer to open one. It is a full
            agent with its own tools, and it does not interrupt this thread.
          </p>
          {!canStart ? (
            <p className="flex items-center gap-1.5 text-[11px] text-warning-foreground">
              <TriangleAlertIcon className="size-3 shrink-0" aria-hidden="true" />
              Choose a model on this thread first.
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {sideChats.map((chat) => (
            <li key={chat.id}>
              <button
                type="button"
                onClick={() => onOpen(chat.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/50"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {chat.title}
                </span>
                {chat.latestTurn?.state === "running" ? (
                  <Spinner className="size-3 shrink-0" />
                ) : null}
                <span className="shrink-0 text-[11px] text-muted-foreground/70">
                  {relativeTime(chat.updatedAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
