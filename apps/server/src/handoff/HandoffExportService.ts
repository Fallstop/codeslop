/**
 * HandoffExportService — turn a frozen thread into a bundle another machine
 * can adopt.
 *
 * Ordering here is the whole safety argument. The provider session is read
 * FIRST, before anything is published, because a missing session is the one
 * failure that must refuse rather than half-move a thread. Only once the bytes
 * are in hand does the worktree get published and the bundle staged.
 *
 * The caller is responsible for having stopped the session before calling
 * this. That is what `originStoppedAt` records, and what the target refuses
 * without.
 *
 * @module handoff/HandoffExportService
 */
import {
  OrchestrationHandoffBundleError,
  type EnvironmentId,
  type HandoffId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { exportHandoffSession, type TransferableProvider } from "./HandoffSessionTransfer.ts";
import { HandoffStagingStore, sha256 } from "./HandoffStagingStore.ts";

/** Where a handoff's published work lives, per handoff. */
export const handoffRefFor = (handoffId: HandoffId): string =>
  `refs/heads/slop/handoff/${handoffId}`;

export interface ExportHandoffInput {
  readonly handoffId: HandoffId;
  readonly originThreadId: ThreadId;
  readonly originEnvironmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
  readonly provider: TransferableProvider;
  readonly providerHome: string;
  readonly sessionId: string;
  readonly cwd: string;
  /** When the caller stopped the session. Proof for the target. */
  readonly originStoppedAt: string;
  readonly originBranch?: string | undefined;
  readonly repositoryRemoteUrl?: string | undefined;
}

export interface ExportHandoffResult {
  readonly sessionBytes: number;
  readonly handoffCommit: string;
  readonly baseCommit: string;
}

const exportError = (message: string, cause?: unknown) =>
  new OrchestrationHandoffBundleError(cause === undefined ? { message } : { message, cause });

export class HandoffExportService extends Context.Service<
  HandoffExportService,
  {
    readonly exportBundle: (
      input: ExportHandoffInput,
    ) => Effect.Effect<ExportHandoffResult, OrchestrationHandoffBundleError>;
  }
>()("t3/handoff/HandoffExportService") {}

const make = Effect.gen(function* () {
  const staging = yield* HandoffStagingStore;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return HandoffExportService.of({
    exportBundle: Effect.fn("HandoffExportService.exportBundle")(function* (input) {
      // Read the session before publishing anything: if the context cannot
      // travel there is no handoff worth doing, and nothing has been changed.
      const session = yield* withPlatform(
        exportHandoffSession({
          provider: input.provider,
          providerHome: input.providerHome,
          sessionId: input.sessionId,
          cwd: input.cwd,
        }),
      ).pipe(
        Effect.mapError((cause) => exportError("Failed to read the provider session.", cause)),
      );

      if (session === null) {
        return yield* exportError(
          `No ${input.provider} session found for '${input.sessionId}'; nothing to hand off.`,
        );
      }

      const published = yield* checkpoints
        .publishHandoffCommit({ cwd: input.cwd, ref: handoffRefFor(input.handoffId) })
        .pipe(Effect.mapError((cause) => exportError("Failed to publish the worktree.", cause)));

      yield* staging.writeSession({ handoffId: input.handoffId, bytes: session.bytes });
      yield* staging.writeManifest({
        handoffId: input.handoffId,
        manifest: {
          handoffId: input.handoffId,
          provider: input.provider,
          sessionId: input.sessionId,
          ...(session.fileName !== undefined ? { sessionFileName: session.fileName } : {}),
          sessionSha256: sha256(session.bytes),
          sessionBytes: session.bytes.length,
          originEnvironmentId: input.originEnvironmentId,
          originThreadId: input.originThreadId,
          targetThreadId: input.targetThreadId,
          ...(input.repositoryRemoteUrl !== undefined
            ? { repositoryRemoteUrl: input.repositoryRemoteUrl }
            : {}),
          handoffRef: handoffRefFor(input.handoffId),
          handoffCommit: published.commit,
          baseCommit: published.baseCommit,
          ...(input.originBranch !== undefined ? { originBranch: input.originBranch } : {}),
          originStoppedAt: input.originStoppedAt,
        },
      });

      return {
        sessionBytes: session.bytes.length,
        handoffCommit: published.commit,
        baseCommit: published.baseCommit,
      };
    }),
  });
});

export const layer = Layer.effect(HandoffExportService, make);
