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
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { claudeProjectSlug } from "../provider/Drivers/ClaudeSessionTransfer.ts";
import { handoffRefFor } from "./HandoffExportService.ts";
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

// One provider home shared by the layer and the assertions below. Outside the
// repo: adopt writes real files, and they must not land in the working tree.
const CLAUDE_HOME = NodePath.join(NodeOS.tmpdir(), "t3-handoff-claude-home");

const TestLayer = bundleLayer.pipe(
  // provideMerge, not provide: the test drives the staging store directly to
  // stand in for the origin having frozen a thread.
  Layer.provideMerge(stagingLayer),
  Layer.provide(settingsLayerFor(CLAUDE_HOME)),
  Layer.provide(sessionRuntimeLayer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(GitVcsDriver.vcsLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-bundle-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 15_000 });
  });

/**
 * A laptop that published in-flight work to a shared remote, and a desktop
 * clone that has never seen it — the situation adopt actually runs in.
 */
const makeRepositories = Effect.fn("makeRepositories")(function* (handoffId: HandoffId) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const remote = path.join(root, "remote.git");
  const laptop = path.join(root, "laptop");
  const desktop = path.join(root, "desktop");

  yield* fileSystem.makeDirectory(remote, { recursive: true });
  yield* git(remote, ["init", "--bare"]);
  yield* fileSystem.makeDirectory(laptop, { recursive: true });
  yield* git(laptop, ["init"]);
  yield* git(laptop, ["config", "user.email", "test@test.com"]);
  yield* git(laptop, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(laptop, "app.ts"), "committed\n");
  yield* git(laptop, ["add", "."]);
  yield* git(laptop, ["commit", "-m", "base"]);
  yield* git(laptop, ["remote", "add", "origin", remote]);
  yield* git(laptop, ["push", "origin", "HEAD:refs/heads/main"]);

  // What the agent had in flight when the user handed off.
  yield* fileSystem.writeFileString(path.join(laptop, "in-flight.txt"), "half a thought\n");

  const driver = yield* VcsDriver.VcsDriver;
  const published = yield* driver.checkpoints!.publishHandoffCommit({
    cwd: laptop,
    ref: handoffRefFor(handoffId),
  });
  yield* git(laptop, ["push", "origin", `${handoffRefFor(handoffId)}:${handoffRefFor(handoffId)}`]);
  yield* git(root, ["clone", remote, desktop]);

  return { root, laptop, desktop, baseCommit: published.baseCommit };
});

const manifestFor = (input: {
  readonly bytes: Uint8Array;
  readonly handoffId: HandoffId;
  readonly baseCommit: string;
}): HandoffBundleManifest => ({
  handoffId: input.handoffId,
  provider: "claudeAgent",
  sessionId: SESSION_ID,
  sessionSha256: sha256(input.bytes),
  sessionBytes: input.bytes.length,
  originEnvironmentId: "env-laptop",
  originThreadId: ThreadId.make("thread-1"),
  targetThreadId: ThreadId.make("thread-2"),
  handoffRef: handoffRefFor(input.handoffId),
  baseCommit: input.baseCommit,
  originStoppedAt: "2026-08-21T00:00:00.000Z",
});

it.layer(TestLayer)("handoff bundle transport", (it) => {
  it.effect("carries a session across in chunks and adopts it onto real work", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staging = yield* HandoffStagingStore;
      const service = yield* HandoffBundleService;
      const repos = yield* makeRepositories(HANDOFF_ID);

      // Bigger than one chunk, so the loop below is the real multi-frame path.
      const session = new TextEncoder().encode(
        `{"type":"user","sessionId":"${SESSION_ID}"}\n`.repeat(12_000),
      );
      expect(session.length).toBeGreaterThan(HANDOFF_CHUNK_BYTES);
      yield* staging.writeManifest({
        handoffId: HANDOFF_ID,
        manifest: manifestFor({
          bytes: session,
          handoffId: HANDOFF_ID,
          baseCommit: repos.baseCommit,
        }),
      });
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
          // The ref travels with the manifest, so the target checks out the
          // same published commit the origin made.
          manifest: { ...read.manifest, handoffId: targetHandoff },
          offset,
          chunk: read.chunk,
        });
        offset += chunkBytes;
      }
      expect(offset).toBe(session.length);

      const adopted = yield* service.adoptBundle({
        handoffId: targetHandoff,
        repositoryPath: repos.desktop,
        worktreePath: path.join(repos.root, "desktop-worktree"),
        branch: "slop/adopted-bundle",
      });
      expect(adopted.sessionId).toBe(SESSION_ID);

      // The agent's in-flight file arrived on a machine that never saw it...
      const carried = yield* fileSystem.readFileString(
        path.join(adopted.worktreePath, "in-flight.txt"),
      );
      expect(carried).toBe("half a thought\n");

      // ...the session landed where this machine's Claude will look for it...
      const resolvedCwd = yield* fileSystem
        .realPath(adopted.worktreePath)
        .pipe(Effect.orElseSucceed(() => adopted.worktreePath));
      const installed = path.join(
        CLAUDE_HOME,
        "projects",
        claudeProjectSlug(resolvedCwd),
        `${SESSION_ID}.jsonl`,
      );
      const landed = yield* fileSystem.readFile(installed);
      expect(sha256(landed)).toBe(sha256(session));

      // ...and the adopted thread is pointed at it, which is what makes the
      // agent continue rather than start over.
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
      const staging = yield* HandoffStagingStore;
      const service = yield* HandoffBundleService;
      const handoffId = HandoffId.make("handoff-corrupt");

      const session = new TextEncoder().encode("original\n");
      yield* staging.writeManifest({
        handoffId,
        manifest: manifestFor({ bytes: session, handoffId, baseCommit: "base" }),
      });
      // Same length, different bytes: only the checksum catches this.
      yield* staging.writeSession({
        handoffId,
        bytes: new TextEncoder().encode("tampered\n"),
      });

      const error = yield* service
        .adoptBundle({
          handoffId,
          repositoryPath: "/nonexistent",
          worktreePath: null,
          branch: "slop/adopted",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationHandoffBundleError");
      // Refused before touching git: a corrupt bundle checks nothing out.
      expect(error.message).toContain("checksum");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a truncated transfer", () =>
    Effect.gen(function* () {
      const staging = yield* HandoffStagingStore;
      const service = yield* HandoffBundleService;
      const handoffId = HandoffId.make("handoff-short");

      const session = new TextEncoder().encode("a much longer session\n");
      yield* staging.writeManifest({
        handoffId,
        manifest: manifestFor({ bytes: session, handoffId, baseCommit: "base" }),
      });
      // The courier died halfway; adopting now would resume a broken transcript.
      yield* staging.writeSession({ handoffId, bytes: session.slice(0, 4) });

      const error = yield* service
        .adoptBundle({
          handoffId,
          repositoryPath: "/nonexistent",
          worktreePath: null,
          branch: "slop/adopted",
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("incomplete");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to adopt a bundle that was never received", () =>
    Effect.gen(function* () {
      const service = yield* HandoffBundleService;
      const error = yield* service
        .adoptBundle({
          handoffId: HandoffId.make("never-arrived"),
          repositoryPath: "/nonexistent",
          worktreePath: null,
          branch: "slop/adopted",
        })
        .pipe(Effect.flip);
      assert.isDefined(error);
    }).pipe(Effect.scoped),
  );
});
