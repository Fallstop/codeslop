import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { importedHistoryItem } from "./ImportedHistory.ts";
import {
  MachineHandoffHistoryJson,
  machineHandoffHistory,
  messagesOnly,
} from "./MachineHandoffHistory.ts";

const encodeHistory = Schema.encodeSync(MachineHandoffHistoryJson);
const decodeHistory = Schema.decodeUnknownSync(MachineHandoffHistoryJson);
const at = DateTime.makeUnsafe("2026-10-12T01:00:00.000Z");
const originThreadId = ThreadId.make("thread:origin");

const base = (id: string) => ({
  id: TurnItemId.make(id),
  threadId: originThreadId,
  runId: RunId.make("run:origin"),
  nodeId: NodeId.make("node:origin"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 7,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

const command = (output: string, status: OrchestrationV2TurnItem["status"] = "completed") =>
  ({
    ...base("item:command"),
    status,
    type: "command_execution",
    input: "ls",
    output,
    exitCode: 0,
  }) satisfies OrchestrationV2TurnItem;

it("carries tool calls between messages and leaves origin-only items behind", () => {
  const history = machineHandoffHistory([
    {
      ...base("item:user"),
      createdBy: "user",
      creationSource: "web",
      type: "user_message",
      messageId: MessageId.make("message:user"),
      inputIntent: "turn_start",
      text: "Build it",
      attachments: [],
    },
    command("README.md"),
    {
      ...command("nested"),
      id: TurnItemId.make("item:nested"),
      parentItemId: TurnItemId.make("x"),
    },
    {
      ...base("item:checkpoint"),
      type: "checkpoint",
      checkpointId: CheckpointId.make("checkpoint:1"),
      scopeId: CheckpointScopeId.make("scope:1"),
      files: [],
    },
  ]);
  assert.deepEqual(history, [
    { role: "user", text: "Build it", createdAt: "2026-10-12T01:00:00.000Z" },
    { item: command("README.md") },
  ]);
  assert.deepEqual(messagesOnly(history), [history[0]!]);
});

it("clips tool output a bundle would otherwise carry in full", () => {
  const [entry] = machineHandoffHistory([command("x".repeat(20_000))]);
  assert.isTrue(entry !== undefined && "item" in entry);
  const item = entry !== undefined && "item" in entry ? entry.item : undefined;
  assert.isTrue(item?.type === "command_execution" && (item.output?.length ?? 0) < 9_000);
});

it("rehomes a carried item and never shows the origin's stopped work as live", () => {
  const targetThreadId = ThreadId.make("thread:target");
  const item = importedHistoryItem({
    threadId: targetThreadId,
    index: 3,
    item: command("partial", "running"),
    idPrefix: "machine-handoff:h1",
  });
  assert.equal(item.id, "machine-handoff:h1:turn-item:thread:target:000003");
  assert.equal(item.threadId, targetThreadId);
  assert.deepEqual([item.runId, item.nodeId, item.ordinal], [null, null, 4]);
  assert.equal(item.status, "interrupted");

  const reasoning = importedHistoryItem({
    threadId: targetThreadId,
    index: 0,
    item: { ...base("item:reasoning"), type: "reasoning", text: "thinking", streaming: true },
    idPrefix: "machine-handoff:h1",
  });
  assert.isTrue(reasoning.type === "reasoning" && !reasoning.streaming);
});

it("survives the bundle's JSON encoding", () => {
  const history = machineHandoffHistory([command("README.md")]);
  assert.deepEqual(decodeHistory(encodeHistory(history)), history);
});
