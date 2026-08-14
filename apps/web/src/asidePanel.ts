/**
 * Pure state and display helpers for thread asides.
 *
 * The panel and the review surface both derive everything they render from
 * these functions, so the two views cannot disagree about what an aside says.
 *
 * @module asidePanel
 */
import type { Aside, AsideContextFidelity, AsideId } from "@t3tools/contracts";

/**
 * Which aside the composer panel is showing.
 *
 * `"new"` is a real state, not the absence of one: the panel is open and
 * focused with nothing asked yet, which is what opening `/btw` should feel
 * like before the first question lands.
 */
export type AsidePanelTarget = AsideId | "new" | null;

export interface ThreadAsideState {
  readonly asides: ReadonlyArray<Aside>;
  readonly target: AsidePanelTarget;
  /** Question in flight, rendered under the exchange until the answer lands. */
  readonly pendingQuestion: string | null;
  readonly errorMessage: string | null;
  /** True once a list has been fetched, so the review surface can tell empty from unloaded. */
  readonly loaded: boolean;
}

export const emptyThreadAsideState: ThreadAsideState = {
  asides: [],
  target: null,
  pendingQuestion: null,
  errorMessage: null,
  loaded: false,
};

/**
 * Replace an aside in place, or append it when new.
 *
 * Order is by creation so the review list reads like the session did. `ask`
 * returns the whole aside, so replacing wholesale is correct — there is no
 * partial state to merge.
 */
export function upsertAside(asides: ReadonlyArray<Aside>, next: Aside): ReadonlyArray<Aside> {
  const index = asides.findIndex((aside) => aside.asideId === next.asideId);
  if (index === -1) {
    return [...asides, next];
  }
  const copy = asides.slice();
  copy[index] = next;
  return copy;
}

export function findAside(
  asides: ReadonlyArray<Aside>,
  target: AsidePanelTarget,
): Aside | undefined {
  if (target === null || target === "new") {
    return undefined;
  }
  return asides.find((aside) => aside.asideId === target);
}

/**
 * The answer shown as an aside's one-line preview in the review list.
 *
 * Prefers the latest answer over the opening question: the title already
 * carries the question, so repeating it in the row below would waste the line.
 */
export function asidePreview(aside: Aside): string {
  for (let index = aside.messages.length - 1; index >= 0; index -= 1) {
    const message = aside.messages[index];
    if (message && message.role === "assistant") {
      return message.text.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

/** Follow-ups make an aside a conversation; the count is worth showing. */
export function asideExchangeCount(aside: Aside): number {
  return aside.messages.filter((message) => message.role === "user").length;
}

export interface FidelityPresentation {
  readonly label: string;
  readonly detail: string;
}

/**
 * How an aside's context is described to the reader.
 *
 * Stated plainly in both directions rather than warning only on the weak one:
 * somebody reading a months-old aside needs to know what the answer was based
 * on, and "answered from the live session" is the load-bearing half of that.
 */
export function fidelityPresentation(fidelity: AsideContextFidelity): FidelityPresentation {
  return fidelity === "session"
    ? {
        label: "Live session",
        detail:
          "Answered from inside the running session, so the agent's tool results were in view. Its reasoning was not.",
      }
    : {
        label: "From transcript",
        detail:
          "Answered from the saved transcript, which holds what was said but no command output, file contents, or test results.",
      };
}

/**
 * Whether a question can be sent right now.
 *
 * A blank question is rejected here rather than at the server so the composer
 * can disable its own button instead of round-tripping to learn it was empty.
 */
export function canAskAside(question: string, pendingQuestion: string | null): boolean {
  return question.trim().length > 0 && pendingQuestion === null;
}

const BTW_COMMAND = /^\/(?:btw|aside)(?:\s+([\s\S]*))?$/;

/**
 * Parse a composer line as the aside command.
 *
 * Returns the question when the line is `/btw` or `/aside`, `null` otherwise.
 * A bare `/btw` yields an empty question, which opens the panel without asking
 * — the same thing the slash command does in a terminal client, and a nicer
 * landing than an error for somebody who has not decided what to ask yet.
 */
export function parseAsideCommand(text: string): { question: string } | null {
  const match = BTW_COMMAND.exec(text.trim());
  if (!match) {
    return null;
  }
  return { question: (match[1] ?? "").trim() };
}
