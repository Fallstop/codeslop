import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-handoff-",
});
const GitLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({
      operation: "GitVcsDriver.handoff.test",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

const HANDOFF_REF = "refs/heads/slop/handoff/handoff-1";

const makeRepo = Effect.fn("makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped();
  yield* runGit(cwd, ["init"]);
  yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(cwd, "committed.txt"), "committed\n");
  yield* runGit(cwd, ["add", "."]);
  yield* runGit(cwd, ["commit", "-m", "base"]);
  return cwd;
});

it.layer(GitLayer)("publishHandoffCommit", (it) => {
  it.effect("carries uncommitted and untracked work but not ignored files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* makeRepo();

      // The whole point of a handoff: work-in-progress moves, so the far side
      // picks up exactly what the agent had, not just the last commit.
      yield* fileSystem.writeFileString(path.join(cwd, "committed.txt"), "edited in flight\n");
      yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "brand new\n");
      yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "secret.env\n");
      yield* fileSystem.writeFileString(path.join(cwd, "secret.env"), "TOKEN=nope\n");

      const published = yield* driver.checkpoints!.publishHandoffCommit({ cwd, ref: HANDOFF_REF });

      const listed = yield* runGit(cwd, ["ls-tree", "-r", "--name-only", published.commit]);
      const names = listed.stdout.trim().split("\n").toSorted();
      expect(names).toContain("untracked.txt");
      expect(names).toContain("committed.txt");
      // Ignored files stay behind; the target rebuilds them from the setup script.
      expect(names).not.toContain("secret.env");

      const blob = yield* runGit(cwd, ["show", `${published.commit}:committed.txt`]);
      expect(blob.stdout).toBe("edited in flight\n");
    }).pipe(Effect.scoped),
  );

  it.effect("parents the commit on HEAD so an ordinary fetch can reach it", () =>
    Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* makeRepo();

      const head = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      const published = yield* driver.checkpoints!.publishHandoffCommit({ cwd, ref: HANDOFF_REF });

      expect(published.baseCommit).toBe(head.stdout.trim());
      const parent = yield* runGit(cwd, ["rev-parse", `${published.commit}^`]);
      expect(parent.stdout.trim()).toBe(published.baseCommit);

      // Under refs/heads, unlike the parentless checkpoint refs.
      const resolved = yield* runGit(cwd, ["rev-parse", "--verify", HANDOFF_REF]);
      expect(resolved.stdout.trim()).toBe(published.commit);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the working tree exactly as the agent left it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* makeRepo();
      yield* fileSystem.writeFileString(path.join(cwd, "committed.txt"), "still dirty\n");

      const before = yield* runGit(cwd, ["status", "--porcelain"]);
      yield* driver.checkpoints!.publishHandoffCommit({ cwd, ref: HANDOFF_REF });
      const after = yield* runGit(cwd, ["status", "--porcelain"]);

      // Publishing uses a temp index, so staging state is untouched — the user
      // can cancel the handoff and keep working here.
      expect(after.stdout).toBe(before.stdout);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a repository with no commits", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* runGit(cwd, ["init"]);

      const error = yield* driver
        .checkpoints!.publishHandoffCommit({ cwd, ref: HANDOFF_REF })
        .pipe(Effect.flip);
      assert.isDefined(error);
    }).pipe(Effect.scoped),
  );
});
