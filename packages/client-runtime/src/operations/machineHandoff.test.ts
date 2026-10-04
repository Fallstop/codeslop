import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MachineHandoffId,
  ThreadId,
  type OrchestrationV2MachineHandoff,
  type OrchestrationV2MachineHandoffManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { runMachineHandoff, type MachineHandoffPorts } from "./machineHandoff.ts";

const handoffId = MachineHandoffId.make("handoff-1");
const payload = "0123456789";
const manifest = {
  handoffId,
  payloadBytes: payload.length,
} as OrchestrationV2MachineHandoffManifest;
const staged = (state: OrchestrationV2MachineHandoff["state"], error?: string) =>
  ({
    id: handoffId,
    target: { environmentId: EnvironmentId.make("desktop"), threadId: ThreadId.make("t") },
    state,
    startedAt: "2026-10-05T00:00:00.000Z",
    ...(error === undefined ? {} : { error }),
  }) satisfies OrchestrationV2MachineHandoff;

/** Ports over an in-memory pair of machines that log what was asked of them. */
function machines(options: {
  readonly staged?: OrchestrationV2MachineHandoff | null;
  readonly adoptFails?: boolean;
}) {
  const log: Array<string> = [];
  let received = "";
  const ports: MachineHandoffPorts<string> = {
    start: Effect.sync(() => log.push("start")),
    awaitStaged: Effect.sync(() => {
      log.push("await");
      return options.staged === undefined ? staged("ready") : options.staged;
    }),
    readBundle: ({ offset, length }) =>
      Effect.sync(() => {
        log.push(`read:${offset}`);
        return {
          manifest,
          chunk: btoa(payload.slice(offset, offset + length)),
          totalBytes: payload.length,
        };
      }),
    writeBundle: ({ offset, chunk, manifest: sent }) =>
      Effect.sync(() => {
        log.push(`write:${offset}${sent === undefined ? "" : ":manifest"}`);
        received = received.slice(0, offset) + atob(chunk);
        return { receivedBytes: received.length };
      }),
    adopt: options.adoptFails
      ? Effect.fail("This machine's checkout has no remote.")
      : Effect.sync(() => {
          log.push("adopt");
          return { threadId: ThreadId.make("adopted"), worktreePath: "/w", context: "native" };
        }),
    complete: () => Effect.sync(() => log.push("complete")),
    fail: (error) => Effect.sync(() => log.push(`fail:${error}`)),
    progress: () => Effect.void,
  };
  return { ports, log, received: () => received };
}

it.effect("stages, copies by offset, adopts, then marks the origin complete", () =>
  Effect.gen(function* () {
    const { ports, log, received } = machines({});
    const adopted = yield* runMachineHandoff({ resume: false, ports, chunkBytes: 4 });
    assert.equal(adopted.threadId, "adopted");
    assert.equal(received(), payload);
    assert.deepEqual(log, [
      "start",
      "await",
      "read:0",
      "write:0:manifest",
      "read:4",
      "write:4",
      "read:8",
      "write:8",
      "adopt",
      "complete",
    ]);
  }),
);

it.effect("resuming a staged handoff skips the start", () =>
  Effect.gen(function* () {
    const { ports, log } = machines({});
    yield* runMachineHandoff({ resume: true, ports });
    assert.notInclude(log, "start");
    assert.include(log, "complete");
  }),
);

it.effect("a refused adopt parks the origin with the reason and never completes", () =>
  Effect.gen(function* () {
    const { ports, log } = machines({ adoptFails: true });
    const error = yield* runMachineHandoff({ resume: true, ports }).pipe(Effect.flip);
    assert.equal(error, "This machine's checkout has no remote.");
    assert.include(log, "fail:The handoff could not reach the other machine.");
    assert.notInclude(log, "complete");
  }),
);

it.effect("stops without copying when the origin could not stage", () =>
  Effect.gen(function* () {
    const { ports, log } = machines({ staged: staged("failed", "No remote.") });
    const error = yield* runMachineHandoff({ resume: true, ports }).pipe(Effect.flip);
    assert.equal(typeof error === "string" ? error : error.message, "No remote.");
    assert.deepEqual(log, ["await"]);
  }),
);
