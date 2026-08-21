/**
 * Handoff courier — carries a bundle from one environment to another.
 *
 * There is no server-to-server channel, so the client moves the bytes: read a
 * chunk from the origin, write it to the target, repeat, then ask the target
 * to verify and install. The loop lives here rather than in a component
 * because it is the part with real behaviour — offsets, resumption, and the
 * stage reporting the UI renders.
 *
 * The two sides arrive as injected ports rather than RPC calls: each half runs
 * against a different environment supervisor, and expressing that as
 * parameters keeps this testable without two live connections.
 *
 * @module operations/handoff
 */
import type {
  HandoffId,
  OrchestrationAdoptHandoffBundleResult,
  OrchestrationHandoffBundleManifest,
  ThreadHandoffStage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Matches the server's frame budget; see HandoffStagingStore. */
export const HANDOFF_CHUNK_BYTES = 256 * 1024;

export interface HandoffCourierPorts<E> {
  /** Read a slice of the staged bundle from the origin environment. */
  readonly readBundle: (input: {
    readonly handoffId: HandoffId;
    readonly offset: number;
    readonly length: number;
  }) => Effect.Effect<
    {
      readonly manifest: OrchestrationHandoffBundleManifest;
      readonly chunk: string;
      readonly totalBytes: number;
    },
    E
  >;
  /** Write that slice into the target environment's staging area. */
  readonly writeBundle: (input: {
    readonly handoffId: HandoffId;
    readonly manifest: OrchestrationHandoffBundleManifest;
    readonly offset: number;
    readonly chunk: string;
  }) => Effect.Effect<{ readonly receivedBytes: number }, E>;
  /** Verify and install on the target. */
  readonly adoptBundle: (input: {
    readonly handoffId: HandoffId;
    readonly cwd: string;
  }) => Effect.Effect<OrchestrationAdoptHandoffBundleResult, E>;
  /**
   * Report progress to the origin so every device watching the thread sees the
   * same stage. Failures here are not fatal — losing a progress update must not
   * abandon a transfer that is otherwise fine.
   */
  readonly reportStage: (stage: ThreadHandoffStage) => Effect.Effect<unknown, E>;
  /**
   * Stamp the origin with where the work went. Runs only after the target has
   * verified and installed, so the origin is never marked handed off to a
   * machine that refused the bundle.
   */
  readonly completeHandoff: (input: {
    readonly adoptedSessionId: string;
  }) => Effect.Effect<unknown, E>;
}

export interface CourierHandoffInput<E> {
  readonly handoffId: HandoffId;
  /** Where the adopted thread will run on the target. */
  readonly targetCwd: string;
  readonly ports: HandoffCourierPorts<E>;
  readonly chunkBytes?: number;
}

const base64Length = (chunk: string): number => {
  if (chunk.length === 0) {
    return 0;
  }
  const padding = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0;
  return (chunk.length / 4) * 3 - padding;
};

/**
 * Move a staged bundle across and adopt it. Returns what the target installed.
 *
 * Offsets drive the loop, so a retry after a dropped connection re-sends only
 * the chunk that was in flight.
 */
export const courierHandoffBundle = Effect.fn("handoff.courierHandoffBundle")(function* <E>(
  input: CourierHandoffInput<E>,
) {
  const chunkBytes = input.chunkBytes ?? HANDOFF_CHUNK_BYTES;
  const ports = input.ports;

  yield* Effect.ignore(ports.reportStage("transferring"));

  let offset = 0;
  let totalBytes: number | null = null;
  let manifest: OrchestrationHandoffBundleManifest | null = null;

  while (totalBytes === null || offset < totalBytes) {
    const read = yield* ports.readBundle({
      handoffId: input.handoffId,
      offset,
      length: chunkBytes,
    });
    totalBytes = read.totalBytes;
    manifest = read.manifest;
    const advanced = base64Length(read.chunk);
    if (advanced === 0) {
      // Defensive: a zero-length chunk before the declared end would spin.
      break;
    }
    yield* ports.writeBundle({
      handoffId: input.handoffId,
      manifest: read.manifest,
      offset,
      chunk: read.chunk,
    });
    offset += advanced;
  }

  yield* Effect.ignore(ports.reportStage("adopting"));

  const adopted = yield* ports.adoptBundle({
    handoffId: input.handoffId,
    cwd: input.targetCwd,
  });

  // Target first, origin second: a crash between the two leaves the work moved
  // and the origin un-annotated, which the user can repair. The reverse would
  // mark a thread handed off to a machine that never received it.
  yield* ports.completeHandoff({ adoptedSessionId: adopted.sessionId });

  return { adopted, manifest, transferredBytes: offset };
});
