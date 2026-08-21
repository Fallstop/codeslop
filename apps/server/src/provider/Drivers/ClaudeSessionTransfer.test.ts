import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectSlug,
  exportClaudeSession,
  installClaudeSession,
} from "./ClaudeSessionTransfer.ts";

it("slugs a path by replacing every non-alphanumeric run character", () => {
  // Verified against claude 2.1.238: a session created in /private/tmp/x/repoA
  // landed in the directory named by this exact substitution.
  expect(claudeProjectSlug("/private/tmp/spike1/repoA")).toBe("-private-tmp-spike1-repoA");
  expect(claudeProjectSlug("/Users/dev/.codeslop/worktrees/app/slop-1a2b")).toBe(
    "-Users-dev--codeslop-worktrees-app-slop-1a2b",
  );
});

it("truncates a long path and appends a hash of the original", () => {
  const long = `/Users/dev/${"segment/".repeat(40)}repo`;
  const slug = claudeProjectSlug(long);
  // 200 characters, a separator, then the base-36 hash.
  expect(slug.length).toBeGreaterThan(200);
  expect(slug.slice(0, 200)).toBe(long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
  expect(slug.slice(200)).toMatch(/^-[0-9a-z]+$/);
});

it("gives different long paths different slugs", () => {
  const a = claudeProjectSlug(`/Users/dev/${"segment/".repeat(40)}repoA`);
  const b = claudeProjectSlug(`/Users/dev/${"segment/".repeat(40)}repoB`);
  expect(a).not.toBe(b);
});

it.layer(NodeServices.layer)("claude session transfer", (it) => {
  it.effect("round-trips a transcript into the directory the target cwd resolves to", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDir = path.join(root, "config");
      const sourceCwd = path.join(root, "repoA");
      const targetCwd = path.join(root, "repoB");
      yield* fileSystem.makeDirectory(sourceCwd, { recursive: true });
      yield* fileSystem.makeDirectory(targetCwd, { recursive: true });

      const sessionId = "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00";
      const transcript = new TextEncoder().encode(
        `{"type":"user","sessionId":"${sessionId}","cwd":"${sourceCwd}"}\n`,
      );
      yield* installClaudeSession({ configDir, cwd: sourceCwd, sessionId, bytes: transcript });

      const exported = yield* exportClaudeSession({ configDir, cwd: sourceCwd, sessionId });
      assert.isNotNull(exported);

      const installedAt = yield* installClaudeSession({
        configDir,
        cwd: targetCwd,
        sessionId,
        bytes: exported!.bytes,
      });

      // The transplant is the directory: same id, a path derived from the new
      // cwd, and bytes untouched — the recorded cwd inside still says repoA.
      expect(installedAt).not.toBe(
        path.join(configDir, "projects", claudeProjectSlug(sourceCwd), `${sessionId}.jsonl`),
      );
      const landed = yield* fileSystem.readFile(installedAt);
      expect(new TextDecoder().decode(landed)).toContain(sourceCwd);
    }).pipe(Effect.scoped),
  );

  it.effect("appends the trailing newline the CLI needs before it writes again", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = path.join(root, "repo");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });

      // A transcript truncated mid-transfer can arrive without its final
      // newline; without one the CLI's next append lands on the same line.
      const installedAt = yield* installClaudeSession({
        configDir: path.join(root, "config"),
        cwd,
        sessionId: "abc",
        bytes: new TextEncoder().encode(`{"type":"user"}`),
      });
      const landed = yield* fileSystem.readFile(installedAt);
      expect(new TextDecoder().decode(landed).endsWith("\n")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a missing transcript instead of failing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      // Refusing before the user's session is stopped depends on this being a
      // null rather than a defect.
      const exported = yield* exportClaudeSession({
        configDir: path.join(root, "config"),
        cwd: root,
        sessionId: "never-existed",
      });
      expect(exported).toBeNull();
    }).pipe(Effect.scoped),
  );
});
