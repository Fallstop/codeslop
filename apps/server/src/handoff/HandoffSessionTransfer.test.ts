import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { installClaudeSession } from "../provider/Drivers/ClaudeSessionTransfer.ts";
import { installCodexSession } from "../provider/Drivers/CodexSessionTransfer.ts";
import {
  exportHandoffSession,
  hasHandoffSession,
  installHandoffSession,
  isTransferableProvider,
} from "./HandoffSessionTransfer.ts";

const CLAUDE_SESSION = "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00";
const CODEX_THREAD = "01a02244-c54a-7602-ae41-8c6c4721451d";
const CODEX_ROLLOUT = `rollout-2026-08-21T15-02-07-${CODEX_THREAD}.jsonl`;

it("only claude and codex can move a session", () => {
  expect(isTransferableProvider("claudeAgent")).toBe(true);
  expect(isTransferableProvider("codex")).toBe(true);
  // OpenCode keeps sessions in a shared database; cursor and grok have no
  // single-file session to carry.
  expect(isTransferableProvider("opencode")).toBe(false);
  expect(isTransferableProvider("cursor")).toBe(false);
  expect(isTransferableProvider("grok")).toBe(false);
});

it.layer(NodeServices.layer)("handoff session transfer", (it) => {
  it.effect("moves a claude session to the directory the new cwd resolves to", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const originHome = path.join(root, "origin-claude");
      const targetHome = path.join(root, "target-claude");
      const originCwd = path.join(root, "repoA");
      const targetCwd = path.join(root, "repoB");
      yield* fileSystem.makeDirectory(originCwd, { recursive: true });
      yield* fileSystem.makeDirectory(targetCwd, { recursive: true });

      yield* installClaudeSession({
        configDir: originHome,
        cwd: originCwd,
        sessionId: CLAUDE_SESSION,
        bytes: new TextEncoder().encode(`{"cwd":"${originCwd}"}\n`),
      });

      const exported = yield* exportHandoffSession({
        provider: "claudeAgent",
        providerHome: originHome,
        sessionId: CLAUDE_SESSION,
        cwd: originCwd,
      });
      assert.isNotNull(exported);

      yield* installHandoffSession({
        provider: "claudeAgent",
        providerHome: targetHome,
        sessionId: CLAUDE_SESSION,
        cwd: targetCwd,
        bytes: exported!.bytes,
      });

      const present = yield* hasHandoffSession({
        provider: "claudeAgent",
        providerHome: targetHome,
        sessionId: CLAUDE_SESSION,
        cwd: targetCwd,
      });
      expect(present).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("moves a codex rollout keeping the filename resume matches on", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const originHome = path.join(root, "origin-codex");
      const targetHome = path.join(root, "target-codex");

      yield* installCodexSession({
        codexHome: originHome,
        fileName: CODEX_ROLLOUT,
        bytes: new TextEncoder().encode(`{"type":"session_meta"}\n`),
      });

      const exported = yield* exportHandoffSession({
        provider: "codex",
        providerHome: originHome,
        sessionId: CODEX_THREAD,
        cwd: root,
      });
      assert.isNotNull(exported);
      expect(exported!.fileName).toBe(CODEX_ROLLOUT);

      yield* installHandoffSession({
        provider: "codex",
        providerHome: targetHome,
        sessionId: CODEX_THREAD,
        cwd: root,
        bytes: exported!.bytes,
        fileName: exported!.fileName,
      });

      const present = yield* hasHandoffSession({
        provider: "codex",
        providerHome: targetHome,
        sessionId: CODEX_THREAD,
        cwd: root,
        fileName: exported!.fileName,
      });
      expect(present).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports nothing to move so a handoff refuses before freezing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const exported = yield* exportHandoffSession({
        provider: "claudeAgent",
        providerHome: root,
        sessionId: "never-existed",
        cwd: root,
      });
      expect(exported).toBeNull();
    }).pipe(Effect.scoped),
  );
});
