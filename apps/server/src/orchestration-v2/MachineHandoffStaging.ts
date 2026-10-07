// @effect-diagnostics-next-line nodeBuiltinImport:off -- sha256Hex is synchronous; Effect Crypto digests are effects.
import * as NodeCrypto from "node:crypto";

import {
  MACHINE_HANDOFF_MAX_PAYLOAD_BYTES,
  OrchestrationV2MachineHandoffManifest,
  type MachineHandoffId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isMachineHandoffError, MachineHandoffError } from "./MachineHandoff.ts";

const ManifestJson = Schema.fromJsonString(OrchestrationV2MachineHandoffManifest);
const AdoptedWorkspaceJson = Schema.fromJsonString(
  Schema.Struct({ worktreePath: Schema.String, branch: Schema.String }),
);
const decodeAdoptedWorkspace = Schema.decodeUnknownEffect(AdoptedWorkspaceJson);
const encodeAdoptedWorkspace = Schema.encodeEffect(AdoptedWorkspaceJson);
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);
const encodeManifest = Schema.encodeEffect(ManifestJson);

export function sha256Hex(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

const stagingError = (message: string) => (cause: unknown) =>
  new MachineHandoffError({ message, cause });

/**
 * A handoff bundle on disk: `<handoffDir>/<id>/manifest.json` and
 * `payload.bin`. The origin writes one when it exports; the target assembles
 * the same shape chunk by chunk, then verifies it before adopting.
 */
export function makeMachineHandoffStaging(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly handoffDir: string;
}) {
  const { fileSystem, path } = input;
  const dirOf = (handoffId: MachineHandoffId) => path.join(input.handoffDir, handoffId);
  const manifestPath = (handoffId: MachineHandoffId) =>
    path.join(dirOf(handoffId), "manifest.json");
  const payloadPath = (handoffId: MachineHandoffId) => path.join(dirOf(handoffId), "payload.bin");

  const writeManifest = (manifest: OrchestrationV2MachineHandoffManifest) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(dirOf(manifest.handoffId), { recursive: true });
      yield* fileSystem.writeFileString(
        manifestPath(manifest.handoffId),
        yield* encodeManifest(manifest),
      );
    }).pipe(Effect.mapError(stagingError("Could not stage the handoff.")));

  /** None when nothing is staged for the id. */
  const readManifest = (handoffId: MachineHandoffId) =>
    fileSystem.readFileString(manifestPath(handoffId)).pipe(
      Effect.option,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<OrchestrationV2MachineHandoffManifest>()),
          onSome: (raw) => decodeManifest(raw).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(stagingError("The staged handoff is unreadable.")),
    );

  const writePayload = (handoffId: MachineHandoffId, bytes: Uint8Array) =>
    fileSystem
      .makeDirectory(dirOf(handoffId), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFile(payloadPath(handoffId), bytes)),
        Effect.mapError(stagingError("Could not stage the handoff.")),
      );

  const payloadSize = (handoffId: MachineHandoffId) =>
    fileSystem.stat(payloadPath(handoffId)).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

  const readChunk = (handoffId: MachineHandoffId, offset: number, length: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(payloadPath(handoffId), { flag: "r" });
        const totalBytes = Number((yield* file.stat).size);
        if (offset >= totalBytes) return { bytes: new Uint8Array(0), totalBytes };
        yield* file.seek(BigInt(offset), "start");
        const bytes = yield* file.readAlloc(Math.min(length, totalBytes - offset));
        return { bytes: Option.getOrElse(bytes, () => new Uint8Array(0)), totalBytes };
      }),
    ).pipe(Effect.mapError(stagingError("The staged handoff is unreadable.")));

  /**
   * Writes one chunk where it belongs, so a resent chunk overwrites instead of
   * duplicating. Offset 0 starts the file over; a later offset must not leave
   * a gap. Returns the bytes now on disk.
   */
  const writeChunk = (handoffId: MachineHandoffId, offset: number, bytes: Uint8Array) =>
    Effect.gen(function* () {
      const received = offset === 0 ? 0 : yield* payloadSize(handoffId);
      if (offset > received) {
        return yield* new MachineHandoffError({
          message: `The handoff transfer skipped ahead to byte ${offset} of ${received} received.`,
        });
      }
      if (offset + bytes.length > MACHINE_HANDOFF_MAX_PAYLOAD_BYTES) {
        return yield* new MachineHandoffError({ message: "The handoff is too large to move." });
      }
      yield* fileSystem.makeDirectory(dirOf(handoffId), { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(payloadPath(handoffId), {
            flag: offset === 0 ? "w" : "r+",
          });
          yield* file.seek(BigInt(offset), "start");
          yield* file.writeAll(bytes);
        }),
      );
      return Math.max(received, offset + bytes.length);
    }).pipe(
      Effect.mapError((cause) =>
        isMachineHandoffError(cause)
          ? cause
          : new MachineHandoffError({ message: "Could not receive the handoff.", cause }),
      ),
    );

  /** The whole payload, only once its size and checksum match the manifest. */
  const readVerifiedPayload = (manifest: OrchestrationV2MachineHandoffManifest) =>
    Effect.gen(function* () {
      const bytes = yield* fileSystem
        .readFile(payloadPath(manifest.handoffId))
        .pipe(Effect.orElseSucceed(() => new Uint8Array(0)));
      if (bytes.length !== manifest.payloadBytes) {
        return yield* new MachineHandoffError({
          message: `The handoff arrived incomplete: ${bytes.length} of ${manifest.payloadBytes} bytes.`,
        });
      }
      if (sha256Hex(bytes) !== manifest.payloadSha256) {
        return yield* new MachineHandoffError({
          message: "The handoff arrived corrupted. Try the transfer again.",
        });
      }
      return bytes;
    });

  const adoptedPath = (handoffId: MachineHandoffId) => path.join(dirOf(handoffId), "adopted.json");

  /** Where a target checked the work out, so a retried adopt reuses it. */
  const writeAdoptedWorkspace = (
    handoffId: MachineHandoffId,
    workspace: { readonly worktreePath: string; readonly branch: string },
  ) =>
    encodeAdoptedWorkspace(workspace).pipe(
      Effect.flatMap((json) => fileSystem.writeFileString(adoptedPath(handoffId), json)),
      Effect.mapError(stagingError("Could not record the adopted workspace.")),
    );

  const readAdoptedWorkspace = (handoffId: MachineHandoffId) =>
    fileSystem
      .readFileString(adoptedPath(handoffId))
      .pipe(Effect.flatMap(decodeAdoptedWorkspace), Effect.option);

  const discard = (handoffId: MachineHandoffId) =>
    fileSystem.remove(dirOf(handoffId), { recursive: true, force: true }).pipe(Effect.ignore);

  return {
    writeManifest,
    readManifest,
    writePayload,
    readChunk,
    writeChunk,
    readVerifiedPayload,
    writeAdoptedWorkspace,
    readAdoptedWorkspace,
    discard,
  };
}
