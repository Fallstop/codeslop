/**
 * HandoffStagingStore — where a handoff bundle waits between machines.
 *
 * A bundle is a manifest plus the provider's own session bytes, staged on disk
 * under `<stateDir>/handoff/<handoffId>/`. The origin writes one when it
 * freezes a thread; the target writes the same shape as the bytes arrive, then
 * reads it back to adopt. Both sides use this service, which is why it takes
 * no view on direction.
 *
 * Bytes move in bounded chunks rather than one payload: RPC frames are JSON,
 * and a multi-megabyte base64 string would be a single blocking parse on the
 * event loop. Observed transcripts run to several megabytes.
 *
 * @module handoff/HandoffStagingStore
 */
import * as NodeCrypto from "node:crypto";

import { OrchestrationHandoffBundleManifest, type HandoffId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

const MANIFEST_FILE = "manifest.json";
const SESSION_FILE = "session.bin";

/** Largest slice a single RPC frame will carry. */
export const HANDOFF_CHUNK_BYTES = 256 * 1024;

/** Refuse anything larger rather than stream an unbounded file into memory. */
export const HANDOFF_MAX_SESSION_BYTES = 64 * 1024 * 1024;

/** One definition, shared with the wire contract. */
export type HandoffBundleManifest = OrchestrationHandoffBundleManifest;

const ManifestJson = Schema.fromJsonString(OrchestrationHandoffBundleManifest);
const decodeManifest = Schema.decodeUnknownSync(ManifestJson);
const encodeManifest = Schema.encodeSync(ManifestJson);

export function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export class HandoffStagingStore extends Context.Service<
  HandoffStagingStore,
  {
    readonly writeManifest: (input: {
      readonly handoffId: HandoffId;
      readonly manifest: HandoffBundleManifest;
    }) => Effect.Effect<void, never>;
    readonly readManifest: (input: {
      readonly handoffId: HandoffId;
    }) => Effect.Effect<HandoffBundleManifest | null, never>;
    readonly writeSession: (input: {
      readonly handoffId: HandoffId;
      readonly bytes: Uint8Array;
    }) => Effect.Effect<void, never>;
    readonly appendSession: (input: {
      readonly handoffId: HandoffId;
      readonly offset: number;
      readonly bytes: Uint8Array;
    }) => Effect.Effect<number, never>;
    readonly readSessionChunk: (input: {
      readonly handoffId: HandoffId;
      readonly offset: number;
      readonly length: number;
    }) => Effect.Effect<{ readonly bytes: Uint8Array; readonly totalBytes: number } | null, never>;
    readonly readSession: (input: {
      readonly handoffId: HandoffId;
    }) => Effect.Effect<Uint8Array | null, never>;
    readonly discard: (input: { readonly handoffId: HandoffId }) => Effect.Effect<void, never>;
  }
>()("t3/handoff/HandoffStagingStore") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const bundleDir = (handoffId: HandoffId) => path.join(config.handoffDir, handoffId);
  const manifestPath = (handoffId: HandoffId) => path.join(bundleDir(handoffId), MANIFEST_FILE);
  const sessionPath = (handoffId: HandoffId) => path.join(bundleDir(handoffId), SESSION_FILE);

  const ensureDir = (handoffId: HandoffId) =>
    fileSystem.makeDirectory(bundleDir(handoffId), { recursive: true }).pipe(Effect.ignore);

  return HandoffStagingStore.of({
    writeManifest: ({ handoffId, manifest }) =>
      Effect.gen(function* () {
        yield* ensureDir(handoffId);
        yield* fileSystem
          .writeFileString(manifestPath(handoffId), encodeManifest(manifest))
          .pipe(Effect.ignore);
      }),

    readManifest: ({ handoffId }) =>
      fileSystem.readFileString(manifestPath(handoffId)).pipe(
        Effect.map((raw) => decodeManifest(raw)),
        // A missing or unreadable manifest is "no bundle", not a defect: the
        // caller turns it into a typed refusal.
        Effect.orElseSucceed(() => null),
      ),

    writeSession: ({ handoffId, bytes }) =>
      Effect.gen(function* () {
        yield* ensureDir(handoffId);
        yield* fileSystem.writeFile(sessionPath(handoffId), bytes).pipe(Effect.ignore);
      }),

    appendSession: ({ handoffId, offset, bytes }) =>
      Effect.gen(function* () {
        yield* ensureDir(handoffId);
        const filePath = sessionPath(handoffId);
        const existing = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.orElseSucceed(() => new Uint8Array(0)));
        // Offset-addressed so a retried chunk overwrites rather than duplicates.
        const next = new Uint8Array(Math.max(existing.length, offset + bytes.length));
        next.set(existing, 0);
        next.set(bytes, offset);
        yield* fileSystem.writeFile(filePath, next).pipe(Effect.ignore);
        return next.length;
      }),

    readSessionChunk: ({ handoffId, offset, length }) =>
      fileSystem.readFile(sessionPath(handoffId)).pipe(
        Effect.map((bytes) => ({
          bytes: bytes.slice(offset, offset + length),
          totalBytes: bytes.length,
        })),
        Effect.orElseSucceed(() => null),
      ),

    readSession: ({ handoffId }) =>
      fileSystem.readFile(sessionPath(handoffId)).pipe(Effect.orElseSucceed(() => null)),

    discard: ({ handoffId }) =>
      fileSystem.remove(bundleDir(handoffId), { recursive: true, force: true }).pipe(Effect.ignore),
  });
});

export const layer = Layer.effect(HandoffStagingStore, make);
