import type { Aside, AsideId, AsideMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  asideExchangeCount,
  asidePreview,
  canAskAside,
  fidelityPresentation,
  findAside,
  parseAsideCommand,
  upsertAside,
} from "./asidePanel";

function message(role: "user" | "assistant", text: string, synthetic = false): AsideMessage {
  return {
    asideMessageId: `${role}-${text}` as AsideMessage["asideMessageId"],
    role,
    text,
    ...(synthetic ? { synthetic: true } : {}),
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function aside(id: string, messages: AsideMessage[], overrides: Partial<Aside> = {}): Aside {
  return {
    asideId: id as AsideId,
    threadId: "thread-1" as Aside["threadId"],
    turnId: null,
    title: "why?",
    fidelity: "session",
    messages,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("upsertAside", () => {
  it("appends an unseen aside", () => {
    const first = aside("a", []);
    const second = aside("b", []);
    expect(upsertAside([first], second)).toEqual([first, second]);
  });

  it("replaces in place, preserving order", () => {
    const first = aside("a", []);
    const second = aside("b", []);
    const updated = aside("a", [message("user", "hi")]);
    expect(upsertAside([first, second], updated)).toEqual([updated, second]);
  });
});

describe("findAside", () => {
  const asides = [aside("a", []), aside("b", [])];

  it("returns undefined for the composing and closed targets", () => {
    expect(findAside(asides, "new")).toBeUndefined();
    expect(findAside(asides, null)).toBeUndefined();
  });

  it("finds by id", () => {
    expect(findAside(asides, "b" as AsideId)?.asideId).toBe("b");
  });
});

describe("asidePreview", () => {
  it("uses the most recent answer, not the question", () => {
    const subject = aside("a", [
      message("user", "what file?"),
      message("assistant", "src/parser.ts"),
      message("user", "which line?"),
      message("assistant", "line 40"),
    ]);
    expect(asidePreview(subject)).toBe("line 40");
  });

  it("collapses whitespace so a multi-line answer fits one row", () => {
    const subject = aside("a", [message("assistant", "line one\n\nline  two")]);
    expect(asidePreview(subject)).toBe("line one line two");
  });

  it("is empty while the first answer is still pending", () => {
    expect(asidePreview(aside("a", [message("user", "what file?")]))).toBe("");
  });
});

describe("asideExchangeCount", () => {
  it("counts questions rather than messages", () => {
    const subject = aside("a", [
      message("user", "one"),
      message("assistant", "answer"),
      message("user", "two"),
      message("assistant", "answer"),
    ]);
    expect(asideExchangeCount(subject)).toBe(2);
  });
});

describe("fidelityPresentation", () => {
  it("says tool output is missing for transcript-backed answers", () => {
    expect(fidelityPresentation("transcript").detail).toContain("no command output");
  });

  it("does not claim reasoning was visible for live-session answers", () => {
    const presented = fidelityPresentation("session");
    expect(presented.label).toBe("Live session");
    expect(presented.detail).toContain("reasoning was not");
  });
});

describe("canAskAside", () => {
  it("rejects blank questions", () => {
    expect(canAskAside("   ", null)).toBe(false);
  });

  it("rejects a second question while one is in flight", () => {
    expect(canAskAside("why?", "earlier question")).toBe(false);
  });

  it("accepts a question when idle", () => {
    expect(canAskAside("why?", null)).toBe(true);
  });
});

describe("parseAsideCommand", () => {
  it("matches /btw and /aside", () => {
    expect(parseAsideCommand("/btw what file?")).toEqual({ question: "what file?" });
    expect(parseAsideCommand("/aside what file?")).toEqual({ question: "what file?" });
  });

  it("opens the panel without asking on a bare command", () => {
    expect(parseAsideCommand("/btw")).toEqual({ question: "" });
    expect(parseAsideCommand("  /btw   ")).toEqual({ question: "" });
  });

  it("keeps multi-line questions intact", () => {
    expect(parseAsideCommand("/btw why this\nand that")).toEqual({
      question: "why this\nand that",
    });
  });

  it("ignores ordinary prompts and lookalike commands", () => {
    expect(parseAsideCommand("btw what file?")).toBeNull();
    expect(parseAsideCommand("/btwx what file?")).toBeNull();
    expect(parseAsideCommand("tell me btw")).toBeNull();
  });
});
