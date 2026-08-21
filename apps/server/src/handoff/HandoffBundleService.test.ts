// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HandoffId, ThreadId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { claudeProjectSlug } from "../provider/Drivers/ClaudeSessionTransfer.ts";
import { HandoffBundleService, layer as bundleLayer } from "./HandoffBundleService.ts";
import {
  HANDOFF_CHUNK_BYTES,
  HandoffStagingStore,
  layer as stagingLayer,
  sha256,
  type HandoffBundleManifest,
} from "./HandoffStagingStore.ts";

const HANDOFF_ID = HandoffId.make("handoff-e2e");
const SESSION_ID = "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00";

/**
 * A settings stub carrying one Claude instance whose home is a temp directory,
 * so adopt writes into the sandbox rather than the developer's real home.
 */
const settingsLayerFor = (claudeHome: string) =>
  Layer.mock(ServerSettingsService)({
    getSettings: Effect.succeed({
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          config: { homePath: claudeHome },
        },
      },
    } as never),
  });

// Captures the cursor adopt seeds, which is what makes the installed session
// actually resume rather than sit unread on disk.
const seededCursors: Array<{ threadId: string; resumeCursor: unknown }> = [];

const sessionRuntimeLayer = Layer.mock(ProviderSessionRuntimeRepository)({
  upsert: (runtime) =>
    Effect.sync(() => {
      seededCursors.push({ threadId: runtime.threadId, resumeCursor: runtime.resumeCursor });
    }),
});

const makeLayer = (claudeHome: string) =>
  bundleLayer.pipe(
    // provideMerge, not provide: the test drives the staging store directly to
    // stand in for the origin having frozen a thread.
    Layer.provideMerge(stagingLayer),
    Layer.provide(settingsLayerFor(claudeHome)),
    Layer.provide(sessionRuntimeLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-bundle-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const manifestFor = (bytes: Uint8Array): HandoffBundleManifest => ({
  handoffId: HANDOFF_ID,
  provider: "claudeAgent",
  sessionId: SESSION_ID,
  sessionSha256: sha256(bytes),
  sessionBytes: bytes.length,
  originEnvironmentId: "env-laptop",
  originThreadId: ThreadId.make("thread-1"),
  targetThreadId: ThreadId.make("thread-2"),
  originStoppedAt: "2026-08-21T00:00:00.000Z",
});

// One provider home shared by the layer and the assertions below. Outside the
// repo: adopt writes real files, and they must not land in the working tree.
const CLAUDE_HOME = NodePath.join(NodeOS.tmpdir(), "t3-handoff-claude-home");

it.layer(makeLayer(CLAUDE_HOME))("handoff bundle transport", (it) => {
  it.effect("carries a session across in chunks and installs it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staging = yield* HandoffStagingStore;
      const service = yield* HandoffBundleService;

      // Bigger than one chunk, so the loop below is the real multi-frame path.
      const session = new TextEncoder().encode(
        `{"type":"user","sessionId":"${SESSION_ID}"}\n`.repeat(12_000),
      );
      expect(session.length).toBeGreaterThan(HANDOFF_CHUNK_BYTES);
      const manifest = manifestFor(session);
      yield* staging.writeManifest({ handoffId: HANDOFF_ID, manifest });
      yield* staging.writeSession({ handoffId: HANDOFF_ID, bytes: session });

      // The courier: read from the origin, write to the target. Same process
      // here, but the same calls a client makes across two environments.
      const targetHandoff = HandoffId.make("handoff-e2e-target");
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const read = yield* service.readBundle({
          handoffId: HANDOFF_ID,
          offset,
          length: HANDOFF_CHUNK_BYTES,
        });
        total = read.totalBytes;
        const chunkBytes = Buffer.from(read.chunk, "base64").length;
        if (chunkBytes === 0) {
          break;
        }
        yield* service.writeBundle({
          handoffId: targetHandoff,
          manifest: { ...read.manifest, handoffId: targetHandoff },
          offset,
          chunk: read.chunk,
        });
        offset += chunkBytes;
      }
      expect(offset).toBe(session.length);

      const targetCwd = yield* fileSystem.makeTempDirectoryScoped();
      const adopted = yield* service.adoptBundle({ handoffId: targetHandoff, cwd: targetCwd });
      expect(adopted.sessionId).toBe(SESSION_ID);

      // Landed where this machine's Claude will look for it.
      const resolvedCwd = yield* fileSystem
        .realPath(targetCwd)
        .pipe(Effect.orElseSucceed(() => targetCwd));
      const installed = path.join(
        CLAUDE_HOME,
        "projects",
        claudeProjectSlug(resolvedCwd),
        `${SESSION_ID}.jsonl`,
      );
      const landed = yield* fileSystem.readFile(installed);
      expect(sha256(landed)).toBe(sha256(session));

      // ...and the adopted thread is pointed at it.
      const seeded = seededCursors.find((entry) => entry.threadId === "thread-2");
      expect(seeded?.resumeCursor).toEqual({
        threadId: "thread-2",
        resume: SESSION_ID,
        turnCount: 0,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a bundle whose bytes do not match its checksum", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const staging = yield* HandoffStagingStore;
      const service = yield* HandoffBundleService;
      const handoffId = HandoffId.make("handoff-corrupt");

      const session = new TextEncoder().encode("original\n");
      yield* staging.writeManifest({
        handoffId,
        manifest: { ...manifestFor(session), handoffId },
      });
      // Same length, different bytes: only the checksum catches this.
      yield* staging.writeSession({
        handoffId,
        bytes: new TextEncoder().encode("tampered\n"),
      });

      const targetCwd = yield* fileSystem.makeTempDirectoryScoped();
      const error = yield* service.adoptBundle({ handoffId, cwd: targetCwd }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationHandoffBundleError");
      expect(error.message).toContain("checksum");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a truncated transfer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const staging = yield* HandoffStagingStore;
      const service = yield* HandoffBundleService;
      const handoffId = HandoffId.make("handoff-short");

      const session = new TextEncoder().encode("a much longer session\n");
      yield* staging.writeManifest({
        handoffId,
        manifest: { ...manifestFor(session), handoffId },
      });
      // The courier died halfway; adopting now would resume a broken transcript.
      yield* staging.writeSession({ handoffId, bytes: session.slice(0, 4) });

      const targetCwd = yield* fileSystem.makeTempDirectoryScoped();
      const error = yield* service.adoptBundle({ handoffId, cwd: targetCwd }).pipe(Effect.flip);
      expect(error.message).toContain("incomplete");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to adopt a bundle that was never received", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const service = yield* HandoffBundleService;
      const targetCwd = yield* fileSystem.makeTempDirectoryScoped();
      const error = yield* service
        .adoptBundle({ handoffId: HandoffId.make("never-arrived"), cwd: targetCwd })
        .pipe(Effect.flip);
      assert.isDefined(error);
    }).pipe(Effect.scoped),
  );
});
