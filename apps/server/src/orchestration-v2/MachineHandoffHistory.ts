/**
 * The timeline a machine handoff carries: messages plus the tool calls and
 * reasoning between them, so the adopted thread reads like the origin's.
 */

import {
  OrchestrationV2MachineHandoffHistoryEntry,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/** The history as the bundle stores it; carried items hold dates that JSON needs encoded. */
export const MachineHandoffHistoryJson = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Array(OrchestrationV2MachineHandoffHistoryEntry)),
);

/** Self-contained item types; others point at records that stay on the origin. */
const CARRIED_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "reasoning",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "error",
  "proposed_plan",
]);

/** Longest text a carried item keeps; tool output is for display, not replay. */
const MAX_ITEM_TEXT = 8_000;

const clip = (text: string) =>
  text.length <= MAX_ITEM_TEXT ? text : `${text.slice(0, MAX_ITEM_TEXT)}\n… [truncated]`;

const clipOptional = (text: string | undefined) => (text === undefined ? undefined : clip(text));

/** Drops an unknown tool payload that would not fit rather than cutting JSON apart. */
const boundUnknown = (value: unknown) =>
  value === undefined || (JSON.stringify(value)?.length ?? 0) <= MAX_ITEM_TEXT ? value : undefined;

function boundItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "reasoning":
      return { ...item, text: clip(item.text) };
    case "command_execution": {
      const { outputOmitted: _omitted, ...rest } = item;
      return { ...rest, input: clip(item.input), output: clipOptional(item.output) };
    }
    case "file_change": {
      const { changes: _changes, ...rest } = item;
      return {
        ...rest,
        diffStr: clipOptional(item.diffStr),
        oldStr: clipOptional(item.oldStr),
        newStr: clipOptional(item.newStr),
      };
    }
    case "dynamic_tool": {
      const { outputOmitted: _omitted, ...rest } = item;
      return { ...rest, input: boundUnknown(item.input), output: boundUnknown(item.output) };
    }
    default:
      return item;
  }
}

export function machineHandoffHistory(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<OrchestrationV2MachineHandoffHistoryEntry> {
  return items.flatMap((item): Array<OrchestrationV2MachineHandoffHistoryEntry> => {
    if (item.type === "user_message" || item.type === "assistant_message") {
      return item.text.trim().length > 0
        ? [
            {
              role: item.type === "user_message" ? "user" : "assistant",
              text: item.text,
              createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
            },
          ]
        : [];
    }
    // Nested items belong to a subagent item that does not move.
    return CARRIED_ITEM_TYPES.has(item.type) && item.parentItemId === null
      ? [{ item: boundItem(item) }]
      : [];
  });
}

/** The same history without tool items, for a bundle that would not fit otherwise. */
export const messagesOnly = (history: ReadonlyArray<OrchestrationV2MachineHandoffHistoryEntry>) =>
  history.filter((entry) => !("item" in entry));
