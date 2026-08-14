/**
 * Thread aside contracts.
 *
 * An aside is a side conversation hanging off a thread: questions the user
 * asks about work in flight without disturbing the agent's turn. The answering
 * agent has no tools and cannot act — it only reads what the thread already
 * knows.
 *
 * Two things separate this from the provider-native one-shot equivalents it
 * can delegate to (Claude Code's `/btw`): an aside accepts follow-ups, and it
 * is persisted, so a thread accumulates a reviewable record of what was asked
 * mid-flight and what the answer was at the time.
 *
 * @module aside
 */
import * as Schema from "effect/Schema";

import { AsideId, AsideMessageId, IsoDateTime, ThreadId, TurnId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const ASIDE_WS_METHODS = {
  list: "aside.list",
  ask: "aside.ask",
  remove: "aside.remove",
} as const;

/**
 * How much of the thread the backend that answered could actually see.
 *
 * - `session`: answered from inside the live provider session, so the agent's
 *   real message history — including tool calls and their results — was in
 *   context.
 * - `transcript`: answered from codeslop's stored transcript, which holds the
 *   prose both sides exchanged but not tool output. Weaker, and the UI says so
 *   rather than letting a confident guess pass for a recollection.
 *
 * Neither backend sees the agent's reasoning: it is not persisted here, and
 * the provider-native path does not expose it either.
 */
export const AsideContextFidelity = Schema.Literals(["session", "transcript"]);
export type AsideContextFidelity = typeof AsideContextFidelity.Type;

export const AsideMessageRole = Schema.Literals(["user", "assistant"]);
export type AsideMessageRole = typeof AsideMessageRole.Type;

export const AsideMessage = Schema.Struct({
  asideMessageId: AsideMessageId,
  role: AsideMessageRole,
  text: Schema.String,
  /**
   * Set when the backend produced this text itself instead of the model
   * answering — e.g. the model tried to call a tool it does not have. Rendered
   * as a notice rather than as an answer.
   */
  synthetic: Schema.optionalKey(Schema.Boolean),
  createdAt: IsoDateTime,
});
export type AsideMessage = typeof AsideMessage.Type;

export const Aside = Schema.Struct({
  asideId: AsideId,
  threadId: ThreadId,
  /**
   * The turn that was running when the aside was opened, or null if the thread
   * was idle. Anchors the aside to what the agent was doing at the time, which
   * is most of what makes it worth reading back later.
   */
  turnId: Schema.NullOr(TurnId),
  /** Derived from the opening question, for the review list. */
  title: Schema.String,
  fidelity: AsideContextFidelity,
  messages: Schema.Array(AsideMessage),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Aside = typeof Aside.Type;

export const AsideListInput = Schema.Struct({
  threadId: ThreadId,
});
export type AsideListInput = typeof AsideListInput.Type;

export const AsideListResult = Schema.Struct({
  asides: Schema.Array(Aside),
});
export type AsideListResult = typeof AsideListResult.Type;

export const AsideAskInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to open a new aside; pass an existing id to ask a follow-up in it. */
  asideId: Schema.optionalKey(AsideId),
  question: Schema.String,
  /**
   * Which model answers. Sent by the client rather than read from the thread so
   * an aside can be pointed at a cheaper model than the one doing the work.
   */
  modelSelection: ModelSelection,
});
export type AsideAskInput = typeof AsideAskInput.Type;

export const AsideAskResult = Schema.Struct({
  aside: Aside,
});
export type AsideAskResult = typeof AsideAskResult.Type;

export const AsideRemoveInput = Schema.Struct({
  threadId: ThreadId,
  asideId: AsideId,
});
export type AsideRemoveInput = typeof AsideRemoveInput.Type;

export const AsideRemoveResult = Schema.Struct({});
export type AsideRemoveResult = typeof AsideRemoveResult.Type;

export class AsideError extends Schema.TaggedErrorClass<AsideError>()("AsideError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Aside ${this.operation} failed: ${this.detail}`;
  }
}
