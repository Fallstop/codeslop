// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, HandoffId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import { installClaudeSession } from "../provider/Drivers/ClaudeSessionTransfer.ts";
import {
  HandoffExportService,
  layer as exportLayer,
  handoffRefFor,
} from "./HandoffExportService.ts";
import { HandoffStagingStore, layer as stagingLayer, sha256 } from "./HandoffStagingStore.ts";

const HANDOFF_ID = HandoffId.make("handoff-export");
const SESSION_ID = "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00";
const CLAUDE_HOME = NodePath.join(NodeOS.tmpdir(), "t3-handoff-export-home");

const VcsRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(GitVcsDriver.layer),
  Layer.provide(GitVcsDriver.vcsLayer),
  Layer.provide(VcsProjectConfig.layer),
);

const TestLayer = exportLayer.pipe(
  Layer.provideMerge(stagingLayer),
  Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsRegistryLayer))),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsRegistryLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-export-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 15_000 });
  });

/** A repository with a reachable remote — what a real handoff requires. */
const makeRepo = Effect.fn("makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const remote = path.join(root, "remote.git");
  const cwd = path.join(root, "laptop");

  yield* fileSystem.makeDirectory(remote, { recursive: true });
  yield* git(remote, ["init", "--bare"]);
  yield* fileSystem.makeDirectory(cwd, { recursive: true });
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(cwd, "app.ts"), "committed\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "base"]);
  yield* git(cwd, ["remote", "add", "origin", remote]);
  yield* git(cwd, ["push", "origin", "HEAD:refs/heads/main"]);
  return { root, remote, cwd };
});

const baseInput = (cwd: string) => ({
  handoffId: HANDOFF_ID,
  originThreadId: ThreadId.make("thread-1"),
  originEnvironmentId: EnvironmentId.make("env-laptop"),
  targetThreadId: ThreadId.make("thread-2"),
  provider: "claudeAgent" as const,
  providerHome: CLAUDE_HOME,
  sessionId: SESSION_ID,
  cwd,
  originStoppedAt: "2026-08-21T00:00:00.000Z",
});

it.layer(TestLayer)("handoff export", (it) => {
  it.effect("stages a bundle and pushes the work the target will fetch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const service = yield* HandoffExportService;
      const staging = yield* HandoffStagingStore;
      const repo = yield* makeRepo();

      const transcript = new TextEncoder().encode(`{"sessionId":"${SESSION_ID}"}\n`);
      yield* installClaudeSession({
        configDir: CLAUDE_HOME,
        cwd: repo.cwd,
        sessionId: SESSION_ID,
        bytes: transcript,
      });

      const result = yield* service.exportBundle(baseInput(repo.cwd));

      const manifest = yield* staging.readManifest({ handoffId: HANDOFF_ID });
      expect(manifest?.sessionBytes).toBe(result.sessionBytes);
      const staged = yield* staging.readSession({ handoffId: HANDOFF_ID });
      expect(manifest?.sessionSha256).toBe(sha256(staged!));
      expect(manifest?.baseCommit).toBe(result.baseCommit);

      // The ref reached the remote. Publishing alone only moves it locally, so
      // without the push a handoff between two machines fails at the fetch.
      const onRemote = yield* git(repo.remote, [
        "rev-parse",
        "--verify",
        handoffRefFor(HANDOFF_ID),
      ]);
      expect(onRemote.stdout.trim()).toBe(result.handoffCommit);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses before publishing when there is no session to carry", () =>
    Effect.gen(function* () {
      const service = yield* HandoffExportService;
      const repo = yield* makeRepo();

      const error = yield* service
        .exportBundle({ ...baseInput(repo.cwd), sessionId: "never-existed" })
        .pipe(Effect.flip);

      expect(error.message).toContain("nothing to hand off");
      // Nothing was published or pushed: a handoff that cannot carry context
      // must leave both the repository and the remote exactly as it found them.
      const onRemote = yield* git(repo.remote, [
        "rev-parse",
        "--verify",
        "--quiet",
        handoffRefFor(HANDOFF_ID),
      ]).pipe(Effect.option);
      expect(onRemote._tag).toBe("None");
    }).pipe(Effect.scoped),
  );

  it.effect("says which remote failed rather than surfacing a git error", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* HandoffExportService;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = path.join(root, "no-remote");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(cwd, "app.ts"), "committed\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "base"]);

      const transcript = new TextEncoder().encode(`{"sessionId":"${SESSION_ID}"}\n`);
      yield* installClaudeSession({
        configDir: CLAUDE_HOME,
        cwd,
        sessionId: SESSION_ID,
        bytes: transcript,
      });

      const error = yield* service.exportBundle(baseInput(cwd)).pipe(Effect.flip);
      // A project with no shared remote cannot hand off, and the message has to
      // say so — this is the most likely real-world refusal.
      expect(error.message).toContain("remote they can reach");
    }).pipe(Effect.scoped),
  );
});
