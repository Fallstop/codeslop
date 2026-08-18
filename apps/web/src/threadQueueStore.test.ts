import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { QueuedTurn, QueuedTurnContent } from "./threadQueue";
import {
  MAX_QUEUED_TURNS_PER_THREAD,
  MAX_QUEUED_TURN_ATTACHMENT_CHARS,
  partitionQueueAttachments,
  readThreadQueueStorageForTest,
  useThreadQueueStore,
  writeThreadQueueStorageForTest,
} from "./threadQueueStore";

const THREAD_KEY = "env-1:thread-1";

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

let nextId = 0;
function identity() {
  nextId += 1;
  return { id: `entry-${nextId}`, createdAt: "2026-01-01T00:00:00.000Z" };
}

function enqueue(text: string, threadKey = THREAD_KEY) {
  return useThreadQueueStore.getState().enqueue(threadKey, makeContent({ text }), identity());
}

function queueFor(threadKey = THREAD_KEY): QueuedTurn[] {
  return useThreadQueueStore.getState().entriesByThreadKey[threadKey] ?? [];
}

beforeEach(() => {
  nextId = 0;
  writeThreadQueueStorageForTest("");
  useThreadQueueStore.setState({ entriesByThreadKey: {} });
});

describe("enqueue", () => {
  it("stacks each queued turn separately, in order", () => {
    enqueue("one");
    enqueue("two");
    enqueue("three");
    expect(queueFor().map((entry) => entry.text)).toEqual(["one", "two", "three"]);
  });

  it("rejects a turn past the cap instead of merging it into the last one", () => {
    for (let index = 0; index < MAX_QUEUED_TURNS_PER_THREAD; index += 1) {
      expect(enqueue(`turn ${index}`).accepted).toBe(true);
    }
    const rejected = enqueue("one too many");
    expect(rejected.accepted).toBe(false);
    expect(queueFor()).toHaveLength(MAX_QUEUED_TURNS_PER_THREAD);
    expect(queueFor().at(-1)?.text).toBe(`turn ${MAX_QUEUED_TURNS_PER_THREAD - 1}`);
  });

  it("keeps threads independent", () => {
    enqueue("thread one");
    enqueue("thread two", "env-1:thread-2");
    expect(queueFor().map((entry) => entry.text)).toEqual(["thread one"]);
    expect(queueFor("env-1:thread-2").map((entry) => entry.text)).toEqual(["thread two"]);
  });
});

describe("drain and edit operations", () => {
  it("restores a dispatched entry to the front after a failed send", () => {
    enqueue("first");
    enqueue("second");

    const dispatched = useThreadQueueStore.getState().removeEntry(THREAD_KEY, queueFor()[0]!.id);
    expect(dispatched?.text).toBe("first");
    expect(queueFor().map((entry) => entry.text)).toEqual(["second"]);

    useThreadQueueStore.getState().restoreEntryToFront(THREAD_KEY, dispatched!);
    expect(queueFor().map((entry) => entry.text)).toEqual(["first", "second"]);
  });

  it("does not duplicate an entry that is already back in the queue", () => {
    enqueue("first");
    const dispatched = useThreadQueueStore.getState().removeEntry(THREAD_KEY, queueFor()[0]!.id)!;
    useThreadQueueStore.getState().restoreEntryToFront(THREAD_KEY, dispatched);
    useThreadQueueStore.getState().restoreEntryToFront(THREAD_KEY, dispatched);
    expect(queueFor()).toHaveLength(1);
  });

  it("returns null when removing an entry that is not queued", () => {
    expect(useThreadQueueStore.getState().removeEntry(THREAD_KEY, "missing")).toBeNull();
  });

  it("edits, reorders, and removes entries", () => {
    enqueue("first");
    enqueue("second");
    const [first, second] = queueFor();

    useThreadQueueStore.getState().setEntryText(THREAD_KEY, first!.id, "edited");
    expect(queueFor()[0]?.text).toBe("edited");

    useThreadQueueStore.getState().moveEntry(THREAD_KEY, second!.id, -1);
    expect(queueFor().map((entry) => entry.text)).toEqual(["second", "edited"]);

    // Moving past either end is a no-op rather than an error.
    useThreadQueueStore.getState().moveEntry(THREAD_KEY, second!.id, -1);
    expect(queueFor().map((entry) => entry.text)).toEqual(["second", "edited"]);

    expect(useThreadQueueStore.getState().removeEntry(THREAD_KEY, second!.id)?.text).toBe("second");
    expect(queueFor().map((entry) => entry.text)).toEqual(["edited"]);
  });

  it("drops the thread key entirely once its queue empties", () => {
    enqueue("only");
    useThreadQueueStore.getState().clearThread(THREAD_KEY);
    expect(useThreadQueueStore.getState().entriesByThreadKey).not.toHaveProperty(THREAD_KEY);
  });

  it("clears only the queues belonging to a removed environment", () => {
    enqueue("keep", "env-2:thread-9");
    enqueue("drop");
    useThreadQueueStore.getState().clearEnvironment(EnvironmentId.make("env-1"));
    expect(Object.keys(useThreadQueueStore.getState().entriesByThreadKey)).toEqual([
      "env-2:thread-9",
    ]);
  });
});

describe("persistence", () => {
  it("round-trips a queued turn through storage", () => {
    enqueue("survives a reload");
    const raw = readThreadQueueStorageForTest();
    expect(raw).toBeTruthy();

    useThreadQueueStore.setState({ entriesByThreadKey: {} });
    writeThreadQueueStorageForTest(raw!);
    expect(queueFor().map((entry) => entry.text)).toEqual(["survives a reload"]);
  });

  it("ignores an unreadable payload instead of throwing at startup", () => {
    writeThreadQueueStorageForTest("{ not json");
    expect(useThreadQueueStore.getState().entriesByThreadKey).toEqual({});
  });
});

describe("partitionQueueAttachments", () => {
  it("keeps attachments in order until the budget is spent", () => {
    const big = "x".repeat(MAX_QUEUED_TURN_ATTACHMENT_CHARS - 10);
    const { kept, droppedNames } = partitionQueueAttachments([
      { id: "1", name: "first.png", mimeType: "image/png", sizeBytes: 1, dataUrl: big },
      { id: "2", name: "second.png", mimeType: "image/png", sizeBytes: 1, dataUrl: big },
    ]);
    expect(kept.map((attachment) => attachment.name)).toEqual(["first.png"]);
    expect(droppedNames).toEqual(["second.png"]);
  });

  it("records dropped names on the queued entry", () => {
    const big = "x".repeat(MAX_QUEUED_TURN_ATTACHMENT_CHARS + 1);
    const result = useThreadQueueStore.getState().enqueue(
      THREAD_KEY,
      makeContent({
        attachments: [
          { id: "1", name: "huge.png", mimeType: "image/png", sizeBytes: 1, dataUrl: big },
        ],
      }),
      identity(),
    );
    expect(result.droppedImageNames).toEqual(["huge.png"]);
    expect(queueFor()[0]?.droppedImageNames).toEqual(["huge.png"]);
    expect(queueFor()[0]?.attachments).toHaveLength(0);
  });
});
