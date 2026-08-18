/**
 * Pure helpers for side chats.
 *
 * A side chat is a real thread linked to the one it was opened from, so it has
 * its own session, tools and turn lifecycle. Everything here is about framing
 * that thread: what to call it, what context to seed it with, and how to merge
 * its messages and tool activity into one readable column.
 *
 * @module sideChat
 */
import type {
  OrchestrationMessage,
  OrchestrationThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import type { WorkLogEntry } from "./session-logic";

/** Titles are a recognition aid in the side-chat list, not a summary. */
const MAX_TITLE_CHARS = 60;

const SIDE_CHAT_COMMAND = /^\/(?:btw|aside)(?:\s+([\s\S]*))?$/;

/**
 * Parse a composer line as the side-chat command.
 *
 * A bare `/btw` yields an empty question, which opens an empty side chat rather
 * than erroring — the same landing a terminal client gives somebody who has not
 * decided what to ask yet.
 */
export function parseSideChatCommand(text: string): { question: string } | null {
  const match = SIDE_CHAT_COMMAND.exec(text.trim());
  if (!match) {
    return null;
  }
  return { question: (match[1] ?? "").trim() };
}

/** Derive a side chat's title from its opening question. */
export function sideChatTitle(question: string): string {
  const firstLine = question.trim().split("\n", 1)[0]?.trim() ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length === 0) {
    return "Side chat";
  }
  if (collapsed.length <= MAX_TITLE_CHARS) {
    return collapsed;
  }
  const clipped = collapsed.slice(0, MAX_TITLE_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace > MAX_TITLE_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}

export interface SideChatSeedInput {
  readonly parentTitle: string;
  readonly question: string;
}

/**
 * The first message sent to a new side chat.
 *
 * Two jobs. It orients the agent — it is answering about work happening
 * elsewhere, not picking up that work. And it fences it off the worktree:
 * another agent is editing these files right now, so investigating is welcome
 * and writing is not. The fence is a prompt instruction rather than a sandbox
 * because a side chat inherits its parent's runtime mode; it is guidance, not
 * a guarantee, which is why it is stated plainly rather than implied.
 */
export function buildSideChatSeedPrompt(input: SideChatSeedInput): string {
  const question = input.question.trim();
  return [
    "You are a side chat opened from another agent session that is still running.",
    `That session's task is: ${input.parentTitle}`,
    "",
    "How to work here:",
    "- Answer questions about that work. You are not taking it over.",
    "- You share its working directory, and that agent is editing files in it right now.",
    "  Read, search, and run read-only commands freely. Do not edit, move, or delete",
    "  files, and do not run commands that change the repository, unless I explicitly",
    "  ask you to in this chat.",
    "- Prefer looking something up over guessing. You have tools; use them.",
    "- Keep answers short unless I ask for depth.",
    ...(question.length > 0 ? ["", `My question: ${question}`] : []),
  ].join("\n");
}

/** Side chats of one parent, oldest first, as the panel lists them. */
export function selectSideChatShells(
  shells: ReadonlyArray<OrchestrationThreadShell>,
  parentThreadId: ThreadId | null,
): ReadonlyArray<OrchestrationThreadShell> {
  if (parentThreadId === null) {
    return [];
  }
  return shells
    .filter((shell) => shell.parentThreadId === parentThreadId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** True when a thread is a side chat and so must stay out of the main lists. */
export function isSideChatShell(shell: {
  readonly parentThreadId?: ThreadId | null | undefined;
}): boolean {
  return shell.parentThreadId !== null && shell.parentThreadId !== undefined;
}

/**
 * Drop side chats from a thread listing; they belong under their parent.
 *
 * The constraint spells out `undefined` as well as `null` so `T` still infers
 * as the caller's own shell type: the field is declared optional, and under
 * exactOptionalPropertyTypes a constraint without `undefined` fails to match
 * and silently widens every list that passes through here.
 */
export function withoutSideChats<
  T extends { readonly parentThreadId?: ThreadId | null | undefined },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  return threads.filter((thread) => !isSideChatShell(thread));
}

export type SideChatRow =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: OrchestrationMessage;
    }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly createdAt: string;
      readonly entry: WorkLogEntry;
    };

/**
 * Interleave the chat's messages with its tool activity in one column.
 *
 * Tool rows are the point of a side chat that can run commands: without them
 * the panel would show an answer with no evidence of the work behind it. Ties
 * on timestamp keep the work row first, so a command reads as preceding the
 * answer that cites it rather than appearing to follow from nowhere.
 */
export function mergeSideChatTimeline(
  messages: ReadonlyArray<OrchestrationMessage>,
  workEntries: ReadonlyArray<WorkLogEntry>,
): ReadonlyArray<SideChatRow> {
  const rows: SideChatRow[] = [
    ...messages.map(
      (message): SideChatRow => ({
        kind: "message",
        id: `message:${message.id}`,
        createdAt: message.createdAt,
        message,
      }),
    ),
    ...workEntries.map(
      (entry): SideChatRow => ({
        kind: "work",
        id: `work:${entry.id}`,
        createdAt: entry.createdAt,
        entry,
      }),
    ),
  ];

  return rows.toSorted((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    if (byTime !== 0) return byTime;
    if (left.kind === right.kind) return left.id.localeCompare(right.id);
    return left.kind === "work" ? -1 : 1;
  });
}

/** Scoped ref for a side chat, given its parent's environment. */
export function sideChatRef(
  environmentId: ScopedThreadRef["environmentId"],
  threadId: ThreadId,
): ScopedThreadRef {
  return { environmentId, threadId };
}
