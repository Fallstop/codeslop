/**
 * Carries a thread between machines. Servers never talk to each other, so the
 * client that reaches both stages on the origin, copies the bundle across,
 * has the target adopt it, then marks the origin moved.
 */
import {
  MACHINE_HANDOFF_CHUNK_BYTES,
  type OrchestrationV2AdoptMachineHandoffResult,
  type OrchestrationV2MachineHandoff,
  type OrchestrationV2MachineHandoffManifest,
  type OrchestrationV2ReadMachineHandoffBundleResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type MachineHandoffProgress =
  | { readonly stage: "staging" }
  | { readonly stage: "transferring"; readonly sentBytes: number; readonly totalBytes: number }
  | { readonly stage: "adopting" };

/** The origin parked or dropped the handoff before it could be carried. */
class MachineHandoffNotStagedError extends Data.TaggedError("MachineHandoffNotStagedError")<{
  readonly message: string;
}> {}

export interface MachineHandoffPorts<E> {
  /** Asks the origin to stage the thread: a start, or a retry of a failed handoff. */
  readonly start: Effect.Effect<unknown, E>;
  /** Resolves with the origin's record once it is ready, failed, or gone. */
  readonly awaitStaged: Effect.Effect<OrchestrationV2MachineHandoff | null, E>;
  readonly readBundle: (input: {
    readonly offset: number;
    readonly length: number;
  }) => Effect.Effect<OrchestrationV2ReadMachineHandoffBundleResult, E>;
  readonly writeBundle: (input: {
    readonly offset: number;
    readonly chunk: string;
    readonly manifest?: OrchestrationV2MachineHandoffManifest;
  }) => Effect.Effect<{ readonly receivedBytes: number }, E>;
  readonly adopt: Effect.Effect<OrchestrationV2AdoptMachineHandoffResult, E>;
  /** Records on the origin where the work went. */
  readonly complete: (
    adopted: OrchestrationV2AdoptMachineHandoffResult,
  ) => Effect.Effect<unknown, E>;
  /** Parks the origin's handoff with a reason the banner shows. */
  readonly fail: (error: string) => Effect.Effect<unknown, E>;
  readonly progress: (progress: MachineHandoffProgress) => Effect.Effect<void>;
}

export function describeMachineHandoffFailure(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = cause.message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return "The handoff could not reach the other machine.";
}

/**
 * Moves the thread; `resume` carries one already staged. The target adopts
 * before the origin is marked complete, so a failure in between leaves a
 * resumable "ready" origin rather than a thread marked moved but never received.
 */
export const runMachineHandoff = Effect.fn("MachineHandoff.run")(function* <E>(input: {
  readonly resume: boolean;
  readonly ports: MachineHandoffPorts<E>;
  readonly chunkBytes?: number;
}) {
  const { ports } = input;
  const chunkBytes = input.chunkBytes ?? MACHINE_HANDOFF_CHUNK_BYTES;
  yield* ports.progress({ stage: "staging" });
  if (!input.resume) yield* ports.start;
  const staged = yield* ports.awaitStaged;
  if (staged?.state !== "ready") {
    return yield* new MachineHandoffNotStagedError({
      message: staged?.error ?? "The handoff was cancelled.",
    });
  }

  return yield* Effect.gen(function* () {
    let offset = 0;
    let totalBytes = Number.POSITIVE_INFINITY;
    while (offset < totalBytes) {
      const read = yield* ports.readBundle({ offset, length: chunkBytes });
      totalBytes = read.manifest.payloadBytes;
      const written = yield* ports.writeBundle({
        offset,
        chunk: read.chunk,
        // The target needs the manifest once, with the first chunk.
        ...(offset === 0 ? { manifest: read.manifest } : {}),
      });
      // A short read before the end would otherwise spin forever.
      if (written.receivedBytes <= offset && offset < totalBytes) {
        return yield* new MachineHandoffNotStagedError({
          message: "The staged handoff ended early. Retry the handoff.",
        });
      }
      offset = written.receivedBytes;
      yield* ports.progress({ stage: "transferring", sentBytes: offset, totalBytes });
    }
    yield* ports.progress({ stage: "adopting" });
    const adopted = yield* ports.adopt;
    yield* ports.complete(adopted);
    return adopted;
  }).pipe(
    Effect.tapError((cause) => Effect.ignore(ports.fail(describeMachineHandoffFailure(cause)))),
  );
});
