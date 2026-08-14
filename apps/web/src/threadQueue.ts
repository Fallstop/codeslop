import type {
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

import type { PersistedComposerImageAttachment } from "./composerDraftStore";
import type { ElementContextDraft } from "./lib/elementContext";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { ReviewCommentContext } from "./reviewCommentContext";
import type { OrchestrationSessionStatus } from "@t3tools/contracts";

/**
 * One turn waiting to be sent to a thread that is currently busy.
 *
 * Images are held as encoded attachments rather than live `File` handles so
 * an entry means the same thing before and after a reload — the queue is the
 * one composer surface whose contents routinely outlive the tab that wrote
 * them. The send path re-inflates them at drain time.
 *
 * The model and mode snapshot is taken at enqueue, not at drain: a queued
 * turn should run with the settings the user was looking at when they queued
 * it, even if they switch models while waiting.
 */
export interface QueuedTurn {
  id: string;
  text: string;
  attachments: PersistedComposerImageAttachment[];
  /** Names of images that exceeded the storage budget and were not persisted. */
  droppedImageNames: string[];
  terminalContexts: TerminalContextDraft[];
  elementContexts: ElementContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  /**
   * The prompt-injected effort already resolved against the model's
   * capabilities, so the drain can apply the prefix without re-deriving
   * provider state that may have moved on while the turn waited.
   */
  injectedPromptEffort: string | null;
  createdAt: string;
}

/** The content half of a queued turn, before it is given an id and a timestamp. */
export type QueuedTurnContent = Omit<QueuedTurn, "id" | "createdAt">;

/**
 * Joins coalesced prompt text with a blank line so two queued thoughts read
 * as separate paragraphs in the turn the agent finally receives. Either side
 * being empty (an image-only queue entry) collapses to the other rather than
 * leaving leading or trailing whitespace.
 */
export function mergeQueuedTurnText(existing: string, addition: string): string {
  const left = existing.trim();
  const right = addition.trim();
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return `${left}\n\n${right}`;
}

function concatById<T extends { id: string }>(
  existing: ReadonlyArray<T>,
  addition: ReadonlyArray<T>,
): T[] {
  const seen = new Set(existing.map((entry) => entry.id));
  return [...existing, ...addition.filter((entry) => !seen.has(entry.id))];
}

/**
 * Folds new composer content into an already-queued turn.
 *
 * Model and mode come from the incoming content: a coalesced turn runs once,
 * so it can only honour one selection, and the most recent choice is the one
 * the user can still see in the composer.
 */
export function mergeQueuedTurnContent(
  existing: QueuedTurn,
  addition: QueuedTurnContent,
): QueuedTurn {
  return {
    ...existing,
    text: mergeQueuedTurnText(existing.text, addition.text),
    attachments: concatById(existing.attachments, addition.attachments),
    droppedImageNames: [...existing.droppedImageNames, ...addition.droppedImageNames],
    terminalContexts: concatById(existing.terminalContexts, addition.terminalContexts),
    elementContexts: concatById(existing.elementContexts, addition.elementContexts),
    previewAnnotations: concatById(existing.previewAnnotations, addition.previewAnnotations),
    reviewComments: concatById(existing.reviewComments, addition.reviewComments),
    modelSelection: addition.modelSelection,
    runtimeMode: addition.runtimeMode,
    interactionMode: addition.interactionMode,
    injectedPromptEffort: addition.injectedPromptEffort,
  };
}

/**
 * How a send should join the queue.
 *
 * `append` starts a fresh turn; `coalesce` folds into the turn already at the
 * back of the queue. The explicit Queue action always appends — that is the
 * whole point of having a second affordance — while an ordinary send folds
 * into whatever is already waiting, so a burst of follow-up thoughts arrives
 * as one turn instead of several.
 */
export type QueueIntent = "append" | "coalesce";

export function applyQueueIntent(
  queue: ReadonlyArray<QueuedTurn>,
  intent: QueueIntent,
  entry: QueuedTurn,
): QueuedTurn[] {
  const last = queue[queue.length - 1];
  if (intent === "append" || !last) {
    return [...queue, entry];
  }
  return [...queue.slice(0, -1), mergeQueuedTurnContent(last, entry)];
}

export interface ThreadQueueDrainInput {
  sessionStatus: OrchestrationSessionStatus | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  environmentUnavailable: boolean;
}

/**
 * Why the queue is not draining right now, or `null` when it is clear to send.
 *
 * `interrupted` and `error` are deliberately holds rather than drains:
 * stopping a turn is the user taking the wheel, and firing the thing they
 * queued a moment earlier would be the opposite of what Stop means. The queue
 * stays put and waits for an explicit send.
 */
export type ThreadQueueHoldReason =
  | "running"
  | "interrupted"
  | "error"
  | "awaiting-response"
  | "busy"
  | "disconnected";

export function threadQueueHoldReason(input: ThreadQueueDrainInput): ThreadQueueHoldReason | null {
  if (input.environmentUnavailable) return "disconnected";
  if (input.sessionStatus === "running" || input.sessionStatus === "starting") return "running";
  if (input.hasPendingApproval || input.hasPendingUserInput) return "awaiting-response";
  if (input.sessionStatus === "interrupted") return "interrupted";
  if (input.sessionStatus === "error") return "error";
  if (input.isSendBusy || input.isConnecting) return "busy";
  return null;
}

export function canDrainThreadQueue(input: ThreadQueueDrainInput): boolean {
  return threadQueueHoldReason(input) === null;
}

/**
 * Copy for the queue's status line. `interrupted` and `error` are the two
 * states a user has to clear by hand, so they say so; the rest are ordinary
 * waiting and stay quiet about it.
 */
export function formatThreadQueueStatus(input: {
  count: number;
  holdReason: ThreadQueueHoldReason | null;
}): string {
  const turns = `${input.count} turn${input.count === 1 ? "" : "s"}`;
  switch (input.holdReason) {
    case "interrupted":
      return `${turns} held — you stopped this turn. Send when you're ready.`;
    case "error":
      return `${turns} held — resolve the thread error to continue.`;
    case "disconnected":
      return `${turns} waiting to reconnect.`;
    case "awaiting-response":
      return `${turns} queued — answer the agent's request first.`;
    default:
      return `${turns} queued, sending automatically.`;
  }
}

/** True when an entry carries anything worth sending. */
export function queuedTurnHasContent(entry: QueuedTurnContent): boolean {
  return (
    entry.text.trim().length > 0 ||
    entry.attachments.length > 0 ||
    entry.terminalContexts.length > 0 ||
    entry.elementContexts.length > 0 ||
    entry.previewAnnotations.length > 0 ||
    entry.reviewComments.length > 0
  );
}

/**
 * One-line preview for a collapsed queue card. Falls back through the
 * attachment kinds so an image-only or annotation-only turn still reads as
 * something rather than as an empty row.
 */
export function formatQueuedTurnPreview(entry: QueuedTurn): string {
  const text = entry.text.trim();
  if (text.length > 0) {
    const firstLine =
      text
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim() ?? text;
    return firstLine;
  }
  const firstImage = entry.attachments[0];
  if (firstImage) {
    return entry.attachments.length === 1
      ? firstImage.name
      : `${firstImage.name} +${entry.attachments.length - 1}`;
  }
  if (entry.previewAnnotations.length > 0) return "Preview annotation";
  if (entry.elementContexts.length > 0) return "Element context";
  if (entry.terminalContexts.length > 0) return "Terminal output";
  if (entry.reviewComments.length > 0) return "Review comments";
  return "Empty turn";
}
