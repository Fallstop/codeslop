import type { OrchestrationMessage, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "./session-logic";
import {
  buildSideChatSeedPrompt,
  isSideChatShell,
  mergeSideChatTimeline,
  parseSideChatCommand,
  selectSideChatShells,
  sideChatTitle,
  withoutSideChats,
} from "./sideChat";

const PARENT = "thread-parent" as ThreadId;

function shell(id: string, parentThreadId: ThreadId | null, createdAt: string) {
  return {
    id: id as ThreadId,
    parentThreadId,
    createdAt,
  } as unknown as OrchestrationThreadShell;
}

function message(id: string, role: "user" | "assistant", createdAt: string): OrchestrationMessage {
  return { id, role, text: `${role} text`, createdAt } as unknown as OrchestrationMessage;
}

function work(id: string, createdAt: string): WorkLogEntry {
  return { id, createdAt, label: "Bash", tone: "tool" } as WorkLogEntry;
}

describe("parseSideChatCommand", () => {
  it("matches /btw and /aside", () => {
    expect(parseSideChatCommand("/btw what changed?")).toEqual({ question: "what changed?" });
    expect(parseSideChatCommand("/aside what changed?")).toEqual({ question: "what changed?" });
  });

  it("opens an empty chat on a bare command", () => {
    expect(parseSideChatCommand("/btw")).toEqual({ question: "" });
    expect(parseSideChatCommand("  /btw  ")).toEqual({ question: "" });
  });

  it("ignores prose and lookalikes", () => {
    expect(parseSideChatCommand("btw what changed?")).toBeNull();
    expect(parseSideChatCommand("/btwx hi")).toBeNull();
    expect(parseSideChatCommand("tell me btw")).toBeNull();
  });
});

describe("sideChatTitle", () => {
  it("collapses whitespace and takes the first line", () => {
    expect(sideChatTitle("  why is   the build slow?\nmore ")).toBe("why is the build slow?");
  });

  it("truncates at a word boundary", () => {
    const question = "explain the caching strategy that the ingestion pipeline uses for embeddings";
    const title = sideChatTitle(question);
    expect(title.endsWith("…")).toBe(true);
    const body = title.slice(0, -1);
    expect(question.startsWith(body)).toBe(true);
    expect(question.charAt(body.length)).toBe(" ");
  });

  it("falls back for an empty question", () => {
    expect(sideChatTitle("   ")).toBe("Side chat");
  });
});

describe("buildSideChatSeedPrompt", () => {
  it("fences the agent off a worktree another agent is editing", () => {
    const prompt = buildSideChatSeedPrompt({ parentTitle: "Refactor parser", question: "why?" });
    expect(prompt).toContain("Refactor parser");
    expect(prompt).toContain("editing files in it right now");
    expect(prompt).toContain("Do not edit, move, or delete");
    expect(prompt).toContain("My question: why?");
  });

  it("omits the question line when opened empty", () => {
    const prompt = buildSideChatSeedPrompt({ parentTitle: "Refactor parser", question: "  " });
    expect(prompt).not.toContain("My question:");
    expect(prompt).toContain("You have tools; use them.");
  });
});

describe("selectSideChatShells", () => {
  const shells = [
    shell("b", PARENT, "2026-08-14T00:00:02.000Z"),
    shell("a", PARENT, "2026-08-14T00:00:01.000Z"),
    shell("other", "thread-else" as ThreadId, "2026-08-14T00:00:00.000Z"),
    shell("root", null, "2026-08-14T00:00:00.000Z"),
  ];

  it("returns only this parent's chats, oldest first", () => {
    expect(selectSideChatShells(shells, PARENT).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns nothing without a parent", () => {
    expect(selectSideChatShells(shells, null)).toEqual([]);
  });
});

describe("isSideChatShell / withoutSideChats", () => {
  it("treats null and absent parents as ordinary threads", () => {
    expect(isSideChatShell({ parentThreadId: null })).toBe(false);
    expect(isSideChatShell({})).toBe(false);
    expect(isSideChatShell({ parentThreadId: PARENT })).toBe(true);
  });

  it("keeps only ordinary threads and preserves the element type", () => {
    const threads = [
      { id: "root", parentThreadId: null },
      { id: "child", parentThreadId: PARENT },
    ];
    const kept = withoutSideChats(threads);
    expect(kept.map((thread) => thread.id)).toEqual(["root"]);
  });
});

describe("mergeSideChatTimeline", () => {
  it("interleaves messages and tool rows by time", () => {
    const rows = mergeSideChatTimeline(
      [
        message("m1", "user", "2026-08-14T00:00:00.000Z"),
        message("m2", "assistant", "2026-08-14T00:00:03.000Z"),
      ],
      [work("w1", "2026-08-14T00:00:01.000Z"), work("w2", "2026-08-14T00:00:02.000Z")],
    );
    expect(rows.map((row) => row.id)).toEqual(["message:m1", "work:w1", "work:w2", "message:m2"]);
  });

  it("puts a tool row before a message sharing its timestamp", () => {
    const at = "2026-08-14T00:00:00.000Z";
    const rows = mergeSideChatTimeline([message("m1", "assistant", at)], [work("w1", at)]);
    expect(rows.map((row) => row.kind)).toEqual(["work", "message"]);
  });

  it("handles a chat with no tool activity", () => {
    const rows = mergeSideChatTimeline([message("m1", "user", "2026-08-14T00:00:00.000Z")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
  });
});
