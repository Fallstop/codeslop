/**
 * HandoffSessionCursor — read the id a provider resumes by out of its cursor.
 *
 * Each adapter persists its own cursor shape in `provider_session_runtime`.
 * Claude stores the transcript uuid under `resume`; Codex stores the thread id
 * it passes to `thread/resume`. A handoff needs that id to find the session on
 * disk, so this is the one place that knows both shapes.
 *
 * @module handoff/HandoffSessionCursor
 */
import type { TransferableProvider } from "./HandoffSessionTransfer.ts";

const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

/**
 * The provider-side session id, or null when the thread has no resumable
 * session — a thread that never started, or whose cursor predates the adapter
 * recording one. Null must refuse the handoff rather than guess.
 */
export function readHandoffSessionId(
  provider: TransferableProvider,
  resumeCursor: unknown,
): string | null {
  if (resumeCursor === null || typeof resumeCursor !== "object") {
    return null;
  }
  const cursor = resumeCursor as Record<string, unknown>;
  // Claude's cursor also carries its own `threadId`, which is codeslop's, not
  // the transcript's — reading the wrong one would look right and find nothing.
  return provider === "claudeAgent" ? readString(cursor, "resume") : readString(cursor, "threadId");
}

/**
 * Build the cursor an adopted thread resumes with.
 *
 * This is what turns a transported file into a continued conversation: without
 * it the adapter starts a fresh session and the transcript sits on disk unused,
 * which reads to the user as an agent that quietly forgot everything.
 *
 * `resumeSessionAt` is deliberately omitted. On the origin it points at the
 * last assistant message, which after a mid-turn freeze precedes the tool call
 * that was interrupted — keeping it would truncate away the very interruption
 * the agent needs to see.
 */
export function makeHandoffResumeCursor(input: {
  readonly provider: TransferableProvider;
  readonly threadId: string;
  readonly sessionId: string;
}): Record<string, unknown> {
  if (input.provider === "claudeAgent") {
    return { threadId: input.threadId, resume: input.sessionId, turnCount: 0 };
  }
  return { threadId: input.sessionId };
}
