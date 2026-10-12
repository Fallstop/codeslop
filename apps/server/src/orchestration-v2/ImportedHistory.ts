import {
  MessageId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const importedSuffix = (index: number) => String(index).padStart(6, "0");

const importedTurnItemId = (input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly idPrefix: string;
}) =>
  TurnItemId.make(`${input.idPrefix}:turn-item:${input.threadId}:${importedSuffix(input.index)}`);

export interface ImportedHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** ISO timestamp. */
  readonly createdAt: string;
}

/**
 * A message brought in from outside V2 (an imported agent session or a thread
 * handed over from another machine), as a runless message plus the turn item
 * the timeline shows. Runless items on a `v1_import` thread are what its first
 * run replays to the provider as context.
 */
export function importedHistoryRecords(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: ImportedHistoryMessage;
  /** Namespaces turn item ids so two importers never collide. */
  readonly idPrefix: string;
}): {
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const suffix = importedSuffix(input.index);
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const at = DateTime.makeUnsafe(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: importedTurnItemId(input),
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.index + 1,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return { message, turnItem };
}

const SETTLED_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const rehome = <Item extends OrchestrationV2TurnItem>(
  item: Item,
  input: { readonly threadId: ThreadId; readonly index: number; readonly idPrefix: string },
): Item => ({
  ...item,
  id: importedTurnItemId(input),
  threadId: input.threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: input.index + 1,
  status: SETTLED_STATUSES.has(item.status) ? item.status : "interrupted",
});

/**
 * A non-message item brought in from another thread, rehomed as a runless item
 * here. Work the origin stopped mid-way shows as interrupted, never as live.
 */
export function importedHistoryItem(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly item: OrchestrationV2TurnItem;
  readonly idPrefix: string;
}): OrchestrationV2TurnItem {
  const rehomed = rehome(input.item, input);
  switch (rehomed.type) {
    case "assistant_message":
    case "reasoning":
    case "proposed_plan":
      return { ...rehomed, streaming: false };
    default:
      return rehomed;
  }
}
