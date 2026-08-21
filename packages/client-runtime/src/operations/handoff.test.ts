import { describe, expect, it } from "vite-plus/test";

import { HandoffId, ThreadId, type OrchestrationHandoffBundleManifest } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { courierHandoffBundle, type HandoffCourierPorts } from "./handoff.ts";

const HANDOFF_ID = HandoffId.make("handoff-1");

// client-runtime also runs in browsers and React Native, so no Buffer here.
const toBase64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const fromBase64 = (chunk: string): Uint8Array =>
  Uint8Array.from(atob(chunk), (character) => character.charCodeAt(0));

class TransferFailed extends Data.TaggedError("TransferFailed")<{ readonly reason: string }> {}

const manifestFor = (bytes: Uint8Array): OrchestrationHandoffBundleManifest => ({
  handoffId: HANDOFF_ID,
  provider: "claudeAgent",
  sessionId: "session-1",
  sessionSha256: "deadbeef",
  sessionBytes: bytes.length,
  originEnvironmentId: "env-laptop",
  originThreadId: ThreadId.make("thread-1"),
  targetThreadId: ThreadId.make("thread-2"),
  originStoppedAt: "2026-08-21T00:00:00.000Z",
});

/** An in-memory pair of environments the courier can move bytes between. */
function makePorts(source: Uint8Array, options?: { readonly failWriteAtOffset?: number }) {
  const written: Array<{ offset: number; bytes: Uint8Array }> = [];
  const stages: Array<string> = [];
  const completions: Array<string> = [];
  let readCalls = 0;
  const manifest = manifestFor(source);

  const ports: HandoffCourierPorts<TransferFailed> = {
    readBundle: ({ offset, length }) =>
      Effect.sync(() => {
        readCalls += 1;
        const slice = source.slice(offset, offset + length);
        return {
          manifest,
          chunk: toBase64(slice),
          totalBytes: source.length,
        };
      }),
    writeBundle: ({ offset, chunk }) =>
      Effect.suspend(() => {
        if (options?.failWriteAtOffset === offset) {
          return Effect.fail(new TransferFailed({ reason: "connection dropped" }));
        }
        const bytes = fromBase64(chunk);
        written.push({ offset, bytes });
        return Effect.succeed({ receivedBytes: offset + bytes.length });
      }),
    adoptBundle: () =>
      Effect.succeed({
        sessionId: "session-1",
        provider: "claudeAgent",
        worktreePath: "/repo/worktree",
      }),
    reportStage: (stage) =>
      Effect.sync(() => {
        stages.push(stage);
      }),
    completeHandoff: () =>
      Effect.sync(() => {
        completions.push("completed");
      }),
  };

  const assembled = () => {
    const total = written.reduce((max, part) => Math.max(max, part.offset + part.bytes.length), 0);
    const out = new Uint8Array(total);
    for (const part of written) {
      out.set(part.bytes, part.offset);
    }
    return out;
  };

  return { ports, written, stages, completions, assembled, readCalls: () => readCalls };
}

describe("courierHandoffBundle", () => {
  it("moves a multi-chunk session across intact", async () => {
    const source = new Uint8Array(1000);
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251;
    }
    const harness = makePorts(source);

    const result = await Effect.runPromise(
      courierHandoffBundle({
        handoffId: HANDOFF_ID,
        repositoryPath: "/repo",
        worktreePath: "/repo/worktree",
        branch: "slop/adopted",
        ports: harness.ports,
        chunkBytes: 256,
      }),
    );

    expect(result.transferredBytes).toBe(source.length);
    expect(harness.assembled()).toEqual(source);
    expect(harness.written.length).toBe(4);
  });

  it("reports the stages the banner renders, in order", async () => {
    const harness = makePorts(new Uint8Array(10));
    await Effect.runPromise(
      courierHandoffBundle({
        handoffId: HANDOFF_ID,
        repositoryPath: "/repo",
        worktreePath: "/repo/worktree",
        branch: "slop/adopted",
        ports: harness.ports,
        chunkBytes: 256,
      }),
    );
    expect(harness.stages).toEqual(["transferring", "adopting"]);
  });

  it("handles a session that fits in one chunk", async () => {
    const source = new TextEncoder().encode("small session\n");
    const harness = makePorts(source);

    const result = await Effect.runPromise(
      courierHandoffBundle({
        handoffId: HANDOFF_ID,
        repositoryPath: "/repo",
        worktreePath: "/repo/worktree",
        branch: "slop/adopted",
        ports: harness.ports,
        chunkBytes: 4096,
      }),
    );

    expect(result.transferredBytes).toBe(source.length);
    expect(harness.assembled()).toEqual(source);
  });

  it("stops rather than spinning when the origin returns nothing", async () => {
    // A bundle that reports bytes it cannot produce would otherwise loop
    // forever, which is worse than a failed handoff.
    const ports: HandoffCourierPorts<TransferFailed> = {
      readBundle: () =>
        Effect.succeed({
          manifest: manifestFor(new Uint8Array(64)),
          chunk: "",
          totalBytes: 64,
        }),
      writeBundle: () => Effect.succeed({ receivedBytes: 0 }),
      adoptBundle: () =>
        Effect.succeed({
          sessionId: "session-1",
          provider: "claudeAgent",
          worktreePath: "/repo/worktree",
        }),
      reportStage: () => Effect.void,
      completeHandoff: () => Effect.void,
    };

    const result = await Effect.runPromise(
      courierHandoffBundle({
        handoffId: HANDOFF_ID,
        repositoryPath: "/repo",
        worktreePath: "/repo/worktree",
        branch: "slop/adopted",
        ports,
      }),
    );
    expect(result.transferredBytes).toBe(0);
  });

  it("surfaces a dropped connection instead of adopting a partial bundle", async () => {
    const source = new Uint8Array(1000);
    const harness = makePorts(source, { failWriteAtOffset: 512 });

    const exit = await Effect.runPromiseExit(
      courierHandoffBundle({
        handoffId: HANDOFF_ID,
        repositoryPath: "/repo",
        worktreePath: "/repo/worktree",
        branch: "slop/adopted",
        ports: harness.ports,
        chunkBytes: 256,
      }),
    );

    expect(exit._tag).toBe("Failure");
    // The origin must not be marked handed off when the bytes never landed.
    expect(harness.completions).toEqual([]);
    // The first two chunks landed; the target's checksum is what stops a
    // partial bundle being adopted if this is retried carelessly.
    expect(harness.written.length).toBe(2);
  });
});
