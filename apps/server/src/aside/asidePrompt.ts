/**
 * Pure prompt construction for thread asides.
 *
 * Two backends answer asides and they need different inputs. The native path
 * hands the provider a single question string and relies on the runtime to
 * supply session context, so all we compose is the aside's own history. The
 * transcript path has to build the whole context itself from stored rows.
 *
 * @module aside/asidePrompt
 */
import type { AsideMessage } from "@t3tools/contracts";

/** Titles are a recognition aid in the review list, not a summary. */
const MAX_TITLE_CHARS = 60;

/**
 * How much stored transcript to hand a transcript-backed aside. Generous
 * enough to cover a working session, bounded so a long-running thread cannot
 * turn one side question into an enormous request.
 */
export const MAX_TRANSCRIPT_CHARS = 24_000;

export interface TranscriptEntry {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

/**
 * Derive an aside's title from its opening question. Trims to the first line
 * so a pasted multi-line question still yields a scannable label.
 */
export function deriveAsideTitle(question: string): string {
  const firstLine = question.trim().split("\n", 1)[0]?.trim() ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length === 0) {
    return "Untitled aside";
  }
  if (collapsed.length <= MAX_TITLE_CHARS) {
    return collapsed;
  }
  // Prefer a word boundary so the label does not end mid-token.
  const clipped = collapsed.slice(0, MAX_TITLE_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace > MAX_TITLE_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}

/**
 * Fold an aside's prior exchanges into the question handed to a native
 * side-question channel, which accepts one string and answers once.
 *
 * The runtime supplies the main conversation; this only has to carry the side
 * conversation, which the runtime knows nothing about.
 */
export function composeNativeSideQuestion(
  history: ReadonlyArray<AsideMessage>,
  question: string,
): string {
  if (history.length === 0) {
    return question;
  }

  const exchanges = history
    .map((message) => `${message.role === "user" ? "Q" : "A"}: ${message.text}`)
    .join("\n\n");

  return [
    "You and I have already exchanged the side questions below about the work you are currently doing.",
    "Treat them as context for the follow-up at the end. Do not repeat answers you have already given.",
    "",
    exchanges,
    "",
    `Follow-up: ${question}`,
  ].join("\n");
}

/**
 * Render stored thread messages as a transcript for the non-native backend.
 *
 * Keeps the tail rather than the head: a side question is nearly always about
 * what just happened, so recent exchanges are worth more than the opening
 * request. When anything is dropped the transcript says so, so the model
 * attributes a gap to truncation instead of concluding it never happened.
 */
export function renderThreadTranscript(
  entries: ReadonlyArray<TranscriptEntry>,
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): string {
  const rendered = entries
    .map((entry) => {
      const text = entry.text.trim();
      return text.length === 0 ? null : `[${entry.role}]\n${text}`;
    })
    .filter((block): block is string => block !== null);

  if (rendered.length === 0) {
    return "(no messages yet)";
  }

  const kept: string[] = [];
  let budget = maxChars;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index] as string;
    // +2 for the blank line joining blocks.
    const cost = block.length + 2;
    if (cost > budget) {
      break;
    }
    budget -= cost;
    kept.unshift(block);
  }

  if (kept.length === 0) {
    // A single message larger than the whole budget: keep its tail so the most
    // recent context survives rather than returning nothing at all.
    const last = rendered[rendered.length - 1] as string;
    return `(earlier messages omitted)\n\n…${last.slice(-maxChars)}`;
  }

  const omitted = rendered.length - kept.length;
  const body = kept.join("\n\n");
  return omitted > 0 ? `(${omitted} earlier message(s) omitted)\n\n${body}` : body;
}

export interface TranscriptAsidePromptInput {
  readonly transcript: string;
  readonly history: ReadonlyArray<AsideMessage>;
  readonly question: string;
}

/**
 * Build the prompt for the transcript-backed aside.
 *
 * The constraints mirror the native channel's so answers feel like the same
 * feature across providers: no tools, one response, and an explicit
 * instruction to admit ignorance rather than offer to go and look. The added
 * warning about tool output is specific to this backend — the transcript
 * genuinely lacks it, and without the warning the model will happily invent
 * what a command printed.
 */
export function buildTranscriptAsidePrompt(input: TranscriptAsidePromptInput): string {
  const priorExchanges =
    input.history.length === 0
      ? ""
      : [
          "",
          "Side questions already asked and answered in this aside:",
          input.history
            .map((message) => `${message.role === "user" ? "Q" : "A"}: ${message.text}`)
            .join("\n\n"),
        ].join("\n");

  return [
    "You are answering a side question about a coding session that is already underway.",
    "",
    "IMPORTANT CONTEXT:",
    "- You are a separate, lightweight agent. The agent doing the work is NOT interrupted and continues in the background.",
    "- You are reading a stored transcript of that session, not participating in it.",
    "- The transcript contains what the user and the agent said to each other. It does NOT contain the output of any command, file read, or other tool the agent used.",
    "",
    "CRITICAL CONSTRAINTS:",
    "- You have NO tools. You cannot read files, run commands, or search.",
    "- This is a one-off response. There will be no follow-up turns.",
    "- Answer only from the transcript below. If it does not contain the answer — especially if answering would require tool output you cannot see — say so plainly.",
    '- Never say "Let me check", "I\'ll look", or otherwise promise to take an action.',
    "- Do not guess at command output, file contents, or test results.",
    "",
    "Return JSON with exactly one key: answer.",
    "",
    "--- TRANSCRIPT START ---",
    input.transcript,
    "--- TRANSCRIPT END ---",
    priorExchanges,
    "",
    `The user asks: ${input.question}`,
  ].join("\n");
}
