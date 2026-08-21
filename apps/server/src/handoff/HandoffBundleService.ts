/**
 * HandoffBundleService — the RPC-facing half of moving a handoff bundle.
 *
 * The origin stages a bundle when it freezes a thread; the client reads it in
 * chunks and writes those chunks to the target; the target verifies and
 * installs the provider session. All three steps live here so the transport is
 * one thing to reason about rather than scattered across handlers.
 *
 * There is no server-to-server channel in this architecture, which is why the
 * client is the courier rather than an implementation shortcut.
 *
 * @module handoff/HandoffBundleService
 */
import {
  OrchestrationHandoffBundleError,
  defaultInstanceIdForDriver,
  type OrchestrationAdoptHandoffBundleInput,
  type OrchestrationAdoptHandoffBundleResult,
  type OrchestrationReadHandoffBundleInput,
  type OrchestrationReadHandoffBundleResult,
  type OrchestrationWriteHandoffBundleInput,
  type OrchestrationWriteHandoffBundleResult,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { prepareHandoffWorktree } from "./HandoffAdoptWorkspace.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeHandoffResumeCursor } from "./HandoffSessionCursor.ts";
import { resolveHandoffProviderHome } from "./HandoffProviderHome.ts";
import { installHandoffSession, isTransferableProvider } from "./HandoffSessionTransfer.ts";
import {
  HANDOFF_MAX_SESSION_BYTES,
  HandoffStagingStore,
  sha256,
  type HandoffBundleManifest,
} from "./HandoffStagingStore.ts";

const bundleError = (message: string, cause?: unknown) =>
  new OrchestrationHandoffBundleError(cause === undefined ? { message } : { message, cause });

export class HandoffBundleService extends Context.Service<
  HandoffBundleService,
  {
    readonly readBundle: (
      input: OrchestrationReadHandoffBundleInput,
    ) => Effect.Effect<OrchestrationReadHandoffBundleResult, OrchestrationHandoffBundleError>;
    readonly writeBundle: (
      input: OrchestrationWriteHandoffBundleInput,
    ) => Effect.Effect<OrchestrationWriteHandoffBundleResult, OrchestrationHandoffBundleError>;
    readonly adoptBundle: (
      input: OrchestrationAdoptHandoffBundleInput,
    ) => Effect.Effect<OrchestrationAdoptHandoffBundleResult, OrchestrationHandoffBundleError>;
  }
>()("t3/handoff/HandoffBundleService") {}

const make = Effect.gen(function* () {
  const staging = yield* HandoffStagingStore;
  const settingsService = yield* ServerSettingsService;
  const providerSessionRuntime = yield* ProviderSessionRuntimeRepository;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  // Captured once so the service surface stays requirement-free: callers get a
  // plain Effect rather than one that drags FileSystem through the RPC layer.
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /** Find this machine's home for the provider a bundle came from. */
  const resolveTargetHome = Effect.fn("HandoffBundleService.resolveTargetHome")(function* (
    provider: string,
  ) {
    if (!isTransferableProvider(provider)) {
      return yield* bundleError(`Provider '${provider}' cannot adopt a handoff.`);
    }
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => bundleError("Failed to read server settings.", cause)),
    );
    const instanceId = defaultInstanceIdForDriver(provider as ProviderDriverKind);
    const instance = settings.providerInstances[instanceId];
    if (instance === undefined) {
      return yield* bundleError(`This machine has no '${provider}' provider configured.`);
    }
    const resolved = yield* resolveHandoffProviderHome(instance);
    if (resolved === null) {
      return yield* bundleError(`Provider '${provider}' cannot adopt a handoff.`);
    }
    return resolved;
  });

  return HandoffBundleService.of({
    readBundle: Effect.fn("HandoffBundleService.readBundle")(function* (input) {
      const manifest = yield* staging.readManifest({ handoffId: input.handoffId });
      if (manifest === null) {
        return yield* bundleError(`No staged handoff bundle for '${input.handoffId}'.`);
      }
      const chunk = yield* staging.readSessionChunk({
        handoffId: input.handoffId,
        offset: input.offset,
        length: input.length,
      });
      if (chunk === null) {
        return yield* bundleError(`Handoff bundle '${input.handoffId}' has no session bytes.`);
      }
      return {
        manifest: manifest as OrchestrationReadHandoffBundleResult["manifest"],
        chunk: Buffer.from(chunk.bytes).toString("base64"),
        totalBytes: chunk.totalBytes,
      };
    }),

    writeBundle: Effect.fn("HandoffBundleService.writeBundle")(function* (input) {
      if (input.manifest.sessionBytes > HANDOFF_MAX_SESSION_BYTES) {
        return yield* bundleError(
          `Handoff session is ${input.manifest.sessionBytes} bytes, over the ${HANDOFF_MAX_SESSION_BYTES} limit.`,
        );
      }
      // The manifest arrives with every chunk so a target that restarted
      // mid-transfer still knows what it is assembling.
      yield* staging.writeManifest({
        handoffId: input.handoffId,
        manifest: input.manifest as HandoffBundleManifest,
      });
      const bytes = new Uint8Array(Buffer.from(input.chunk, "base64"));
      const receivedBytes = yield* staging.appendSession({
        handoffId: input.handoffId,
        offset: input.offset,
        bytes,
      });
      return { receivedBytes };
    }),

    adoptBundle: Effect.fn("HandoffBundleService.adoptBundle")(function* (input) {
      const manifest = yield* staging.readManifest({ handoffId: input.handoffId });
      if (manifest === null) {
        return yield* bundleError(`No handoff bundle received for '${input.handoffId}'.`);
      }
      // Without this the origin might still be running the thread, and both
      // machines would drive the same conversation.
      if (!manifest.originStoppedAt) {
        return yield* bundleError("Handoff bundle does not record the origin stopping.");
      }

      const session = yield* staging.readSession({ handoffId: input.handoffId });
      if (session === null) {
        return yield* bundleError(`Handoff bundle '${input.handoffId}' has no session bytes.`);
      }
      if (session.length !== manifest.sessionBytes) {
        return yield* bundleError(
          `Handoff session is incomplete: ${session.length} of ${manifest.sessionBytes} bytes.`,
        );
      }
      if (sha256(session) !== manifest.sessionSha256) {
        return yield* bundleError("Handoff session failed its checksum.");
      }

      const home = yield* withPlatform(resolveTargetHome(manifest.provider));

      // Lay the worktree out before installing: Claude keys its session on the
      // directory, so the real directory has to exist first.
      if (manifest.handoffRef === undefined || manifest.baseCommit === undefined) {
        return yield* bundleError("Handoff bundle does not record published work to check out.");
      }
      const worktreePath = yield* prepareHandoffWorktree({
        repositoryPath: input.repositoryPath,
        worktreePath: input.worktreePath,
        branch: input.branch,
        remoteName: input.remoteName ?? "origin",
        handoffRef: manifest.handoffRef,
        baseCommit: manifest.baseCommit,
      }).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, gitDriver),
        Effect.mapError((cause) => bundleError("Failed to check out the handed-off work.", cause)),
      );
      yield* withPlatform(
        installHandoffSession({
          provider: home.provider,
          providerHome: home.providerHome,
          sessionId: manifest.sessionId,
          cwd: worktreePath,
          bytes: session,
          fileName: manifest.sessionFileName,
        }),
      ).pipe(Effect.mapError((cause) => bundleError("Failed to install the session.", cause)));

      // Seed the cursor the adopted thread resumes with. Installing the file
      // alone is not enough: without a cursor the adapter starts a fresh
      // session and the transcript sits on disk unread.
      const lastSeenAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* providerSessionRuntime
        .upsert({
          threadId: manifest.targetThreadId,
          providerName: manifest.provider,
          providerInstanceId: defaultInstanceIdForDriver(manifest.provider as ProviderDriverKind),
          adapterKey: manifest.provider,
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt,
          resumeCursor: makeHandoffResumeCursor({
            provider: home.provider,
            threadId: manifest.targetThreadId,
            sessionId: manifest.sessionId,
          }),
          runtimePayload: null,
        })
        .pipe(Effect.mapError((cause) => bundleError("Failed to seed the resume cursor.", cause)));

      return { sessionId: manifest.sessionId, provider: manifest.provider, worktreePath };
    }),
  });
});

export const layer = Layer.effect(HandoffBundleService, make);
