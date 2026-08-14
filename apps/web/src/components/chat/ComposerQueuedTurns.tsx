import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  ImageIcon,
  LayersIcon,
  SendHorizonalIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import {
  formatQueuedTurnPreview,
  formatThreadQueueStatus,
  type QueuedTurn,
  type ThreadQueueHoldReason,
} from "~/threadQueue";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerQueuedTurnsProps {
  entries: ReadonlyArray<QueuedTurn>;
  holdReason: ThreadQueueHoldReason | null;
  /**
   * The turn an ordinary send would fold into, or null when the composer is
   * empty. Highlighting it is what makes the two send affordances legible:
   * without it, Enter and the Queue action look like the same button.
   */
  coalesceTargetId: string | null;
  /** Label for the queue shortcut, e.g. "⌘⇧↵". Omitted when unbound. */
  queueShortcutLabel: string | null;
  onEditText: (entryId: string, text: string) => void;
  onRemove: (entryId: string) => void;
  onMove: (entryId: string, direction: -1 | 1) => void;
  onSendNow: () => void;
  onClearAll: () => void;
  className?: string;
}

/** Holds the user has to clear by hand get an explicit send affordance. */
function holdNeedsUserAction(holdReason: ThreadQueueHoldReason | null): boolean {
  return holdReason === "interrupted" || holdReason === "error";
}

const QueuedTurnRow = memo(function QueuedTurnRow({
  entry,
  index,
  total,
  isCoalesceTarget,
  isEditing,
  onBeginEdit,
  onCommitEdit,
  onCancelEdit,
  onRemove,
  onMove,
}: {
  entry: QueuedTurn;
  index: number;
  total: number;
  isCoalesceTarget: boolean;
  isEditing: boolean;
  onBeginEdit: () => void;
  onCommitEdit: (text: string) => void;
  onCancelEdit: () => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const [draft, setDraft] = useState(entry.text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-seed from the entry each time the row opens, so an edit abandoned by
  // clicking away does not resurface the next time the row is opened.
  useEffect(() => {
    if (!isEditing) return;
    setDraft(entry.text);
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entry.text, isEditing]);

  const attachmentCount = entry.attachments.length;
  const hasDroppedImages = entry.droppedImageNames.length > 0;

  if (isEditing) {
    return (
      <li className="rounded-xl border border-ring/60 bg-background p-2 ring-[3px] ring-ring/16">
        <Textarea
          ref={textareaRef}
          value={draft}
          size="sm"
          aria-label={`Edit queued turn ${index + 1}`}
          className="border-0 bg-transparent shadow-none ring-0 dark:bg-transparent"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancelEdit();
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.stopPropagation();
              onCommitEdit(draft);
            }
          }}
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <Button size="xs" variant="ghost" onClick={onCancelEdit}>
            Cancel
          </Button>
          <Button size="xs" variant="outline" onClick={() => onCommitEdit(draft)}>
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group/queued-turn relative flex items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors duration-150",
        isCoalesceTarget
          ? "border-ring/45 bg-accent/35"
          : "border-transparent hover:border-border/70 hover:bg-accent/25",
      )}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted font-medium text-[11px] text-muted-foreground tabular-nums"
      >
        {index + 1}
      </span>

      <button
        type="button"
        className="min-w-0 flex-1 cursor-text truncate text-left text-sm text-foreground/90"
        onClick={onBeginEdit}
        aria-label={`Edit queued turn ${index + 1}`}
      >
        {formatQueuedTurnPreview(entry)}
      </button>

      {attachmentCount > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
          <ImageIcon className="size-3" aria-hidden="true" />
          {attachmentCount}
        </span>
      ) : null}

      {hasDroppedImages ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label="Some images were not saved with this queued turn"
                className="shrink-0 text-amber-600"
              >
                <CircleAlertIcon className="size-3.5" />
              </span>
            }
          />
          <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
            {entry.droppedImageNames.join(", ")} exceeded the storage limit and will not be sent
            with this turn.
          </TooltipPopup>
        </Tooltip>
      ) : null}

      {isCoalesceTarget ? (
        <Kbd className="shrink-0 bg-transparent text-[10px] text-muted-foreground">↵ adds here</Kbd>
      ) : null}

      {/* Row actions stay mounted for keyboard users and fade in on hover. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/queued-turn:opacity-100">
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={index === 0}
          aria-label={`Move queued turn ${index + 1} earlier`}
          onClick={() => onMove(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={index === total - 1}
          aria-label={`Move queued turn ${index + 1} later`}
          onClick={() => onMove(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove queued turn ${index + 1}`}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </span>
    </li>
  );
});

/**
 * The stack of turns waiting for the current one to finish, shown directly
 * above the composer.
 *
 * Deliberately static: this sits under a running agent for minutes at a time,
 * and a pulsing or spinning queue would repaint continuously for no
 * information. State changes are carried by the status line and the
 * coalesce-target highlight instead.
 */
export const ComposerQueuedTurns = memo(function ComposerQueuedTurns({
  entries,
  holdReason,
  coalesceTargetId,
  queueShortcutLabel,
  onEditText,
  onRemove,
  onMove,
  onSendNow,
  onClearAll,
  className,
}: ComposerQueuedTurnsProps) {
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  const commitEdit = useCallback(
    (entryId: string, text: string) => {
      onEditText(entryId, text);
      setEditingEntryId(null);
    },
    [onEditText],
  );

  // An entry that drains or is removed while open must not leave the row stuck
  // in edit mode against an entry that no longer exists.
  useEffect(() => {
    if (editingEntryId === null) return;
    if (!entries.some((entry) => entry.id === editingEntryId)) {
      setEditingEntryId(null);
    }
  }, [editingEntryId, entries]);

  if (entries.length === 0) return null;

  const needsAction = holdNeedsUserAction(holdReason);

  return (
    <section
      data-composer-queued-turns="true"
      aria-label="Queued turns"
      className={cn(
        "rounded-[18px] border bg-card1/70 px-2 py-1.5",
        needsAction ? "border-warning/40" : "border-border/70",
        className,
      )}
    >
      <header className="flex items-center gap-2 px-1 pb-1">
        <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {formatThreadQueueStatus({ count: entries.length, holdReason })}
        </p>
        {needsAction ? (
          <Button size="xs" variant="outline" onClick={onSendNow}>
            <SendHorizonalIcon />
            Send now
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={onClearAll}
          aria-label={`Clear all ${entries.length} queued turns`}
        >
          Clear
        </Button>
      </header>

      <ul className="flex flex-col gap-0.5">
        {entries.map((entry, index) => (
          <QueuedTurnRow
            key={entry.id}
            entry={entry}
            index={index}
            total={entries.length}
            isCoalesceTarget={entry.id === coalesceTargetId}
            isEditing={entry.id === editingEntryId}
            onBeginEdit={() => setEditingEntryId(entry.id)}
            onCommitEdit={(text) => commitEdit(entry.id, text)}
            onCancelEdit={() => setEditingEntryId(null)}
            onRemove={() => onRemove(entry.id)}
            onMove={(direction) => onMove(entry.id, direction)}
          />
        ))}
      </ul>

      {queueShortcutLabel && coalesceTargetId ? (
        <p className="px-1 pt-1 text-[11px] text-muted-foreground/80">
          <Kbd className="bg-transparent px-0 text-[11px]">{queueShortcutLabel}</Kbd> queues as a
          separate turn instead.
        </p>
      ) : null}
    </section>
  );
});
