import { describe, expect, it } from "vite-plus/test";

import { HandoffId, ThreadId, type OrchestrationHandoffBundleManifest } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { runHandoffTransfer, type HandoffTransferPorts } from "./handoffTransfer.ts";

const HANDOFF_ID = HandoffId.make("handoff-1");
const TARGET_THREAD = ThreadId.make("thread-on-target");

const toBase64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

class TransferFailed extends Data.TaggedError("TransferFailed")<{ readonly message: string }> {}

const manifest: OrchestrationHandoffBundleManifest = {
  handoffId: HANDOFF_ID,
  provider: "claudeAgent",
  sessionId: "session-1",
  sessionSha256: "deadbeef",
  sessionBytes: 8,
  originEnvironmentId: "env-laptop",
  originThreadId: ThreadId.make("thread-1"),
  targetThreadId: TARGET_THREAD,
  originStoppedAt: "2026-08-21T00:00:00.000Z",
};

function makePorts(overrides?: Partial<HandoffTransferPorts<TransferFailed>>) {
  const order: Array<string> = [];
  const failures: Array<{ stage: string; error: string }> = [];
  const source = new TextEncoder().encode("session!");

  const ports: HandoffTransferPorts<TransferFailed> = {
    readBundle: ({ offset, length }) =>
      Effect.succeed({
        manifest,
        chunk: toBase64(source.slice(offset, offset + length)),
        totalBytes: source.length,
      }),
    writeBundle: () => Effect.succeed({ receivedBytes: source.length }),
    adoptBundle: () =>
      Effect.sync(() => {
        order.push("adopt");
        return {
          sessionId: "session-1",
          provider: "claudeAgent",
          worktreePath: "/desktop/worktree",
        };
      }),
    reportStage: () => Effect.void,
    createContinuationThread: () =>
      Effect.sync(() => {
        order.push("create-thread");
      }),
    startContinuationTurn: () =>
      Effect.sync(() => {
        order.push("start-turn");
      }),
    completeHandoff: () =>
      Effect.sync(() => {
        order.push("complete");
      }),
    reportFailure: (input) =>
      Effect.sync(() => {
        failures.push(input);
      }),
    ...overrides,
  };

  return { ports, order, failures };
}

const run = <E>(ports: HandoffTransferPorts<E>, startImmediately = true) =>
  Effect.runPromiseExit(
    runHandoffTransfer({
      handoffId: HANDOFF_ID,
      targetThreadId: TARGET_THREAD,
      repositoryPath: "/desktop/repo",
      worktreePath: "/desktop/worktree",
      branch: "slop/adopted",
      ports,
      startImmediately,
      chunkBytes: 1024,
    }),
  );

describe("runHandoffTransfer", () => {
  it("adopts, creates the thread, starts it, then marks the origin done", async () => {
    const harness = makePorts();
    const exit = await run(harness.ports);
    expect(exit._tag).toBe("Success");
    // The origin is marked last, on purpose: it must never claim the work is
    // elsewhere before it actually is.
    expect(harness.order).toEqual(["adopt", "create-thread", "start-turn", "complete"]);
  });

  it("does not start a turn when the user did not ask for one", async () => {
    const harness = makePorts();
    await run(harness.ports, false);
    expect(harness.order).toEqual(["adopt", "create-thread", "complete"]);
  });

  it("never marks the origin done when adopting fails", async () => {
    const harness = makePorts({
      adoptBundle: () => Effect.fail(new TransferFailed({ message: "checksum mismatch" })),
    });
    const exit = await run(harness.ports);
    expect(exit._tag).toBe("Failure");
    expect(harness.order).not.toContain("complete");
    // ...and the user is told why, since the thread is already stopped.
    expect(harness.failures).toEqual([{ stage: "transferring", error: "checksum mismatch" }]);
  });

  it("never marks the origin done when the target thread cannot be created", async () => {
    const harness = makePorts({
      createContinuationThread: () => Effect.fail(new TransferFailed({ message: "no project" })),
    });
    const exit = await run(harness.ports);
    expect(exit._tag).toBe("Failure");
    expect(harness.order).toEqual(["adopt"]);
    expect(harness.failures).toEqual([{ stage: "adopting", error: "no project" }]);
  });

  it("still completes when only the first turn fails", async () => {
    // The work and the session are already there; a failed first turn is
    // retryable on the target, not a reason to call the handoff broken.
    const harness = makePorts({
      startContinuationTurn: () => Effect.fail(new TransferFailed({ message: "busy" })),
    });
    const exit = await run(harness.ports);
    expect(exit._tag).toBe("Success");
    expect(harness.order).toEqual(["adopt", "create-thread", "complete"]);
  });
});
