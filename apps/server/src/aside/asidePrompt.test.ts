import type { AsideMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTranscriptAsidePrompt,
  composeNativeSideQuestion,
  deriveAsideTitle,
  renderThreadTranscript,
  type TranscriptEntry,
} from "./asidePrompt.ts";

function message(role: "user" | "assistant", text: string): AsideMessage {
  return {
    asideMessageId: `m-${role}-${text.slice(0, 4)}` as AsideMessage["asideMessageId"],
    role,
    text,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

describe("deriveAsideTitle", () => {
  it("collapses whitespace and keeps a short question whole", () => {
    expect(deriveAsideTitle("  why   is the   build slow?  ")).toBe("why is the build slow?");
  });

  it("uses only the first line of a multi-line question", () => {
    expect(deriveAsideTitle("what does this do?\nhere is a big paste\nand more")).toBe(
      "what does this do?",
    );
  });

  it("truncates at a word boundary rather than mid-token", () => {
    const question = "explain the caching strategy that the ingestion pipeline uses for embeddings";
    const title = deriveAsideTitle(question);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61);
    // The kept body must end where a word ends in the source, not mid-token.
    const body = title.slice(0, -1);
    expect(question.startsWith(body)).toBe(true);
    expect(question.charAt(body.length)).toBe(" ");
  });

  it("falls back to a placeholder for an empty question", () => {
    expect(deriveAsideTitle("   \n  ")).toBe("Untitled aside");
  });
});

describe("composeNativeSideQuestion", () => {
  it("passes a first question through untouched", () => {
    expect(composeNativeSideQuestion([], "what file is that in?")).toBe("what file is that in?");
  });

  it("carries prior exchanges into a follow-up", () => {
    const composed = composeNativeSideQuestion(
      [message("user", "what are you doing?"), message("assistant", "refactoring the parser")],
      "why that order?",
    );
    expect(composed).toContain("Q: what are you doing?");
    expect(composed).toContain("A: refactoring the parser");
    expect(composed).toContain("Follow-up: why that order?");
  });
});

describe("renderThreadTranscript", () => {
  const entries: ReadonlyArray<TranscriptEntry> = [
    { role: "user", text: "add a cache" },
    { role: "assistant", text: "done, added an LRU" },
    { role: "user", text: "make it bigger" },
  ];

  it("renders labelled blocks in order", () => {
    const rendered = renderThreadTranscript(entries);
    expect(rendered).toBe(
      "[user]\nadd a cache\n\n[assistant]\ndone, added an LRU\n\n[user]\nmake it bigger",
    );
  });

  it("skips blank messages", () => {
    expect(renderThreadTranscript([{ role: "user", text: "   " }])).toBe("(no messages yet)");
  });

  it("keeps the most recent messages when over budget and says what it dropped", () => {
    const rendered = renderThreadTranscript(entries, 40);
    expect(rendered).toContain("earlier message(s) omitted");
    expect(rendered).toContain("make it bigger");
    expect(rendered).not.toContain("add a cache");
  });

  it("keeps the tail of a single oversized message rather than nothing", () => {
    const rendered = renderThreadTranscript([{ role: "assistant", text: "x".repeat(500) }], 50);
    expect(rendered).toContain("earlier messages omitted");
    expect(rendered.length).toBeLessThan(200);
    expect(rendered.endsWith("x")).toBe(true);
  });
});

describe("buildTranscriptAsidePrompt", () => {
  it("warns that tool output is absent so the model does not invent it", () => {
    const prompt = buildTranscriptAsidePrompt({
      transcript: "[user]\nrun the tests",
      history: [],
      question: "did they pass?",
    });
    expect(prompt).toContain("does NOT contain the output of any command");
    expect(prompt).toContain("Do not guess at command output");
    expect(prompt).toContain("The user asks: did they pass?");
  });

  it("includes prior aside exchanges when following up", () => {
    const prompt = buildTranscriptAsidePrompt({
      transcript: "[user]\nrun the tests",
      history: [message("user", "did they pass?"), message("assistant", "I cannot see the output")],
      question: "what would you check?",
    });
    expect(prompt).toContain("Side questions already asked");
    expect(prompt).toContain("A: I cannot see the output");
  });
});
