import { describe, expect, it } from "vite-plus/test";

import {
  applyQueueIntent,
  canDrainThreadQueue,
  formatQueuedTurnPreview,
  formatThreadQueueStatus,
  mergeQueuedTurnContent,
  mergeQueuedTurnText,
  queuedTurnHasContent,
  threadQueueHoldReason,
  type QueuedTurn,
  type QueuedTurnContent,
  type ThreadQueueDrainInput,
} from "./threadQueue";

function makeContent(overrides: Partial<QueuedTurnContent> = {}): QueuedTurnContent {
  return {
    text: "",
    attachments: [],
    droppedImageNames: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    modelSelection: { instanceId: "codex", model: "gpt-5" } as QueuedTurn["modelSelection"],
    runtimeMode: "local" as QueuedTurn["runtimeMode"],
    interactionMode: "default" as QueuedTurn["interactionMode"],
    injectedPromptEffort: null,
    ...overrides,
  };
}

function makeEntry(id: string, overrides: Partial<QueuedTurnContent> = {}): QueuedTurn {
  return { ...makeContent(overrides), id, createdAt: "2026-01-01T00:00:00.000Z" };
}

function makeDrainInput(overrides: Partial<ThreadQueueDrainInput> = {}): ThreadQueueDrainInput {
  return {
    sessionStatus: "ready",
    hasPendingApproval: false,
    hasPendingUserInput: false,
    isSendBusy: false,
    isConnecting: false,
    environmentUnavailable: false,
    ...overrides,
  };
}

describe("mergeQueuedTurnText", () => {
  it("separates coalesced thoughts with a blank line", () => {
    expect(mergeQueuedTurnText("first", "second")).toBe("first\n\nsecond");
  });

  it("collapses to the non-empty side so image-only entries add no whitespace", () => {
    expect(mergeQueuedTurnText("", "second")).toBe("second");
    expect(mergeQueuedTurnText("first", "   ")).toBe("first");
    expect(mergeQueuedTurnText("", "")).toBe("");
  });
});

describe("applyQueueIntent", () => {
  it("appends a new turn for the explicit queue action", () => {
    const queue = [makeEntry("a", { text: "first" })];
    const next = applyQueueIntent(queue, "append", makeEntry("b", { text: "second" }));
    expect(next.map((entry) => entry.text)).toEqual(["first", "second"]);
  });

  it("coalesces an ordinary send into the turn already waiting", () => {
    const queue = [makeEntry("a", { text: "first" })];
    const next = applyQueueIntent(queue, "coalesce", makeEntry("b", { text: "second" }));
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe("first\n\nsecond");
    // The merged turn keeps the original entry's identity so its card does not
    // remount and lose edit focus mid-merge.
    expect(next[0]?.id).toBe("a");
  });

  it("creates the first turn when coalescing into an empty queue", () => {
    const next = applyQueueIntent([], "coalesce", makeEntry("a", { text: "only" }));
    expect(next.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("coalesces into the back of the queue, not the front", () => {
    const queue = [makeEntry("a", { text: "first" }), makeEntry("b", { text: "second" })];
    const next = applyQueueIntent(queue, "coalesce", makeEntry("c", { text: "third" }));
    expect(next.map((entry) => entry.text)).toEqual(["first", "second\n\nthird"]);
  });
});

describe("mergeQueuedTurnContent", () => {
  it("takes model and mode from the incoming content", () => {
    const existing = makeEntry("a", {
      modelSelection: { instanceId: "codex", model: "gpt-5" } as QueuedTurn["modelSelection"],
      interactionMode: "default" as QueuedTurn["interactionMode"],
    });
    const merged = mergeQueuedTurnContent(
      existing,
      makeContent({
        modelSelection: {
          instanceId: "claudeAgent",
          model: "claude-opus-5",
        } as QueuedTurn["modelSelection"],
        interactionMode: "plan" as QueuedTurn["interactionMode"],
      }),
    );
    expect(merged.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5" });
    expect(merged.interactionMode).toBe("plan");
  });

  it("does not duplicate an attachment that is already on the entry", () => {
    const attachment = {
      id: "img-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA",
    };
    const existing = makeEntry("a", { attachments: [attachment] });
    const merged = mergeQueuedTurnContent(existing, makeContent({ attachments: [attachment] }));
    expect(merged.attachments).toHaveLength(1);
  });
});

describe("threadQueueHoldReason", () => {
  it("drains once the thread is idle", () => {
    expect(threadQueueHoldReason(makeDrainInput())).toBeNull();
    expect(canDrainThreadQueue(makeDrainInput())).toBe(true);
  });

  it("holds while the turn is still running or starting", () => {
    expect(threadQueueHoldReason(makeDrainInput({ sessionStatus: "running" }))).toBe("running");
    expect(threadQueueHoldReason(makeDrainInput({ sessionStatus: "starting" }))).toBe("running");
  });

  it("holds after an interrupt rather than firing what Stop was meant to prevent", () => {
    expect(threadQueueHoldReason(makeDrainInput({ sessionStatus: "interrupted" }))).toBe(
      "interrupted",
    );
  });

  it("holds while the agent is waiting on an approval or a question", () => {
    expect(threadQueueHoldReason(makeDrainInput({ hasPendingApproval: true }))).toBe(
      "awaiting-response",
    );
    expect(threadQueueHoldReason(makeDrainInput({ hasPendingUserInput: true }))).toBe(
      "awaiting-response",
    );
  });

  it("reports the running turn ahead of a pending request it opened", () => {
    // Session status stays "running" through an approval, so both holds are
    // live at once. "running" is the more useful thing to say.
    expect(
      threadQueueHoldReason(makeDrainInput({ sessionStatus: "running", hasPendingApproval: true })),
    ).toBe("running");
  });

  it("holds on a thread error and on an unavailable environment", () => {
    expect(threadQueueHoldReason(makeDrainInput({ sessionStatus: "error" }))).toBe("error");
    expect(threadQueueHoldReason(makeDrainInput({ environmentUnavailable: true }))).toBe(
      "disconnected",
    );
  });

  it("holds while a send is already in flight", () => {
    expect(threadQueueHoldReason(makeDrainInput({ isSendBusy: true }))).toBe("busy");
    expect(threadQueueHoldReason(makeDrainInput({ isConnecting: true }))).toBe("busy");
  });
});

describe("formatThreadQueueStatus", () => {
  it("says why the queue is parked when the user has to act", () => {
    expect(formatThreadQueueStatus({ count: 1, holdReason: "interrupted" })).toContain(
      "you stopped this turn",
    );
    expect(formatThreadQueueStatus({ count: 2, holdReason: "error" })).toContain("2 turns");
  });

  it("stays quiet about ordinary waiting", () => {
    expect(formatThreadQueueStatus({ count: 1, holdReason: "running" })).toBe(
      "1 turn queued, sending automatically.",
    );
  });
});

describe("queuedTurnHasContent", () => {
  it("rejects whitespace-only text with no attachments", () => {
    expect(queuedTurnHasContent(makeContent({ text: "   \n " }))).toBe(false);
  });

  it("accepts an attachment-only turn", () => {
    expect(
      queuedTurnHasContent(
        makeContent({
          attachments: [
            {
              id: "i",
              name: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              dataUrl: "data:,",
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("formatQueuedTurnPreview", () => {
  it("uses the first non-empty line", () => {
    expect(formatQueuedTurnPreview(makeEntry("a", { text: "\n\n  hello  \nworld" }))).toBe("hello");
  });

  it("falls back to attachments so an image-only turn is not a blank row", () => {
    const entry = makeEntry("a", {
      attachments: [
        { id: "1", name: "before.png", mimeType: "image/png", sizeBytes: 1, dataUrl: "data:," },
        { id: "2", name: "after.png", mimeType: "image/png", sizeBytes: 1, dataUrl: "data:," },
      ],
    });
    expect(formatQueuedTurnPreview(entry)).toBe("before.png +1");
  });
});
