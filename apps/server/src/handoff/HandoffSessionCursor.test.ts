import { expect, it } from "@effect/vitest";

import { readHandoffSessionId } from "./HandoffSessionCursor.ts";

it("reads the transcript uuid from a claude cursor", () => {
  // Shape from ClaudeAdapter: `resume` is the transcript, `threadId` is
  // codeslop's own id and must not be mistaken for it.
  const cursor = {
    threadId: "thread-1",
    resume: "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00",
    resumeSessionAt: "uuid-of-last-assistant",
    turnCount: 3,
  };
  expect(readHandoffSessionId("claudeAgent", cursor)).toBe("f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00");
});

it("reads the thread id from a codex cursor", () => {
  const cursor = { threadId: "01a02244-c54a-7602-ae41-8c6c4721451d" };
  expect(readHandoffSessionId("codex", cursor)).toBe("01a02244-c54a-7602-ae41-8c6c4721451d");
});

it("returns null for a thread with no resumable session", () => {
  // Every one of these must refuse the handoff rather than guess an id and
  // hand off a thread whose context silently did not travel.
  expect(readHandoffSessionId("claudeAgent", null)).toBeNull();
  expect(readHandoffSessionId("claudeAgent", undefined)).toBeNull();
  expect(readHandoffSessionId("claudeAgent", {})).toBeNull();
  expect(readHandoffSessionId("claudeAgent", { threadId: "thread-1" })).toBeNull();
  expect(readHandoffSessionId("claudeAgent", { resume: "   " })).toBeNull();
  expect(readHandoffSessionId("codex", { threadId: 42 })).toBeNull();
  expect(readHandoffSessionId("codex", "not-an-object")).toBeNull();
});
