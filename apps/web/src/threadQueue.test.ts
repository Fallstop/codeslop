import { describe, expect, it } from "vite-plus/test";

import {
  canDrainThreadQueue,
  formatQueuedTurnPreview,
  formatThreadQueueStatus,
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
