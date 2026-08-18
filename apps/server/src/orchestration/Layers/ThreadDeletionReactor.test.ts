import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSideChatDeleteCommands,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("buildSideChatDeleteCommands", () => {
  it("deletes every side chat of the deleted thread", () => {
    const commands = buildSideChatDeleteCommands({
      eventId: "event-1",
      children: [{ threadId: ThreadId.make("side-a") }, { threadId: ThreadId.make("side-b") }],
    });

    expect(commands.map((command) => [command.type, command.threadId])).toEqual([
      ["thread.delete", "side-a"],
      ["thread.delete", "side-b"],
    ]);
  });

  it("derives command ids from the event so a replay resolves to the same commands", () => {
    const children = [{ threadId: ThreadId.make("side-a") }];
    const first = buildSideChatDeleteCommands({ eventId: "event-1", children });
    const replay = buildSideChatDeleteCommands({ eventId: "event-1", children });
    const laterDeletion = buildSideChatDeleteCommands({ eventId: "event-2", children });

    expect(first[0]?.commandId).toBe(replay[0]?.commandId);
    expect(first[0]?.commandId).not.toBe(laterDeletion[0]?.commandId);
  });

  it("gives each side chat its own command id", () => {
    const commands = buildSideChatDeleteCommands({
      eventId: "event-1",
      children: [{ threadId: ThreadId.make("side-a") }, { threadId: ThreadId.make("side-b") }],
    });

    expect(new Set(commands.map((command) => command.commandId)).size).toBe(2);
  });

  it("emits nothing for a thread with no side chats", () => {
    expect(buildSideChatDeleteCommands({ eventId: "event-1", children: [] })).toEqual([]);
  });
});
