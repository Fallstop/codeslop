// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, HandoffId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
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

let publishedRef: string | null = null;

const checkpointStoreLayer = Layer.mock(CheckpointStore.CheckpointStore)({
  publishHandoffCommit: ({ ref }) =>
    Effect.sync(() => {
      publishedRef = ref;
      return { commit: "commit-oid", baseCommit: "base-oid" };
    }),
});

const TestLayer = exportLayer.pipe(
  Layer.provideMerge(stagingLayer),
  Layer.provide(checkpointStoreLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-export-" })),
  Layer.provideMerge(NodeServices.layer),
);

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
  it.effect("stages a bundle the target can verify", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const service = yield* HandoffExportService;
      const staging = yield* HandoffStagingStore;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();

      const transcript = new TextEncoder().encode(`{"sessionId":"${SESSION_ID}"}\n`);
      yield* installClaudeSession({
        configDir: CLAUDE_HOME,
        cwd,
        sessionId: SESSION_ID,
        bytes: transcript,
      });

      const result = yield* service.exportBundle(baseInput(cwd));
      expect(result.handoffCommit).toBe("commit-oid");
      expect(publishedRef).toBe(handoffRefFor(HANDOFF_ID));

      const manifest = yield* staging.readManifest({ handoffId: HANDOFF_ID });
      expect(manifest?.sessionBytes).toBe(result.sessionBytes);
      expect(manifest?.originStoppedAt).toBe("2026-08-21T00:00:00.000Z");
      // The checksum the target will re-compute before installing anything.
      const staged = yield* staging.readSession({ handoffId: HANDOFF_ID });
      expect(manifest?.sessionSha256).toBe(sha256(staged!));
      expect(manifest?.baseCommit).toBe("base-oid");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses before publishing when there is no session to carry", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const service = yield* HandoffExportService;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      publishedRef = null;

      const error = yield* service
        .exportBundle({ ...baseInput(cwd), sessionId: "never-existed" })
        .pipe(Effect.flip);

      expect(error.message).toContain("nothing to hand off");
      // Nothing was published: a handoff that cannot carry context must leave
      // the repository exactly as it found it.
      expect(publishedRef).toBeNull();
    }).pipe(Effect.scoped),
  );
});
