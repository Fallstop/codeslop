import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { handoffRefFor } from "./HandoffExportService.ts";
import { prepareHandoffWorktree } from "./HandoffAdoptWorkspace.ts";
import { HandoffId } from "@t3tools/contracts";

const GitLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-adopt-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const HANDOFF_ID = HandoffId.make("handoff-adopt");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 15_000 });
  });

it.layer(GitLayer)("handoff worktree adoption", (it) => {
  it.effect("recreates the origin's uncommitted work on another machine", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const remote = path.join(root, "remote.git");
      const laptop = path.join(root, "laptop");
      const desktop = path.join(root, "desktop");

      // A shared remote both machines can reach, as a real handoff requires.
      yield* fileSystem.makeDirectory(remote, { recursive: true });
      yield* git(remote, ["init", "--bare"]);

      yield* fileSystem.makeDirectory(laptop, { recursive: true });
      yield* git(laptop, ["init"]);
      yield* git(laptop, ["config", "user.email", "test@test.com"]);
      yield* git(laptop, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(laptop, "app.ts"), "const committed = 1;\n");
      yield* git(laptop, ["add", "."]);
      yield* git(laptop, ["commit", "-m", "base"]);
      yield* git(laptop, ["remote", "add", "origin", remote]);
      yield* git(laptop, ["push", "origin", "HEAD:refs/heads/main"]);

      // The agent's in-flight work: an edit and a file git has never seen.
      yield* fileSystem.writeFileString(path.join(laptop, "app.ts"), "const inFlight = 2;\n");
      yield* fileSystem.writeFileString(path.join(laptop, "scratch.md"), "half a thought\n");

      const driver = yield* VcsDriver.VcsDriver;
      const published = yield* driver.checkpoints!.publishHandoffCommit({
        cwd: laptop,
        ref: handoffRefFor(HANDOFF_ID),
      });
      yield* git(laptop, [
        "push",
        "origin",
        `${handoffRefFor(HANDOFF_ID)}:${handoffRefFor(HANDOFF_ID)}`,
      ]);

      // The other machine: an ordinary clone that has never seen this work.
      yield* git(root, ["clone", remote, desktop]);
      yield* git(desktop, ["config", "user.email", "test@test.com"]);
      yield* git(desktop, ["config", "user.name", "Test"]);

      const worktreePath = yield* prepareHandoffWorktree({
        repositoryPath: desktop,
        worktreePath: path.join(root, "desktop-worktree"),
        branch: "slop/adopted-1",
        remoteName: "origin",
        handoffRef: handoffRefFor(HANDOFF_ID),
        baseCommit: published.baseCommit,
      });

      // The edit arrived...
      const app = yield* fileSystem.readFileString(path.join(worktreePath, "app.ts"));
      expect(app).toBe("const inFlight = 2;\n");
      // ...the untracked file arrived...
      const scratch = yield* fileSystem.readFileString(path.join(worktreePath, "scratch.md"));
      expect(scratch).toBe("half a thought\n");

      // ...and both are uncommitted, exactly as the agent left them. Without
      // the reset they would have arrived as somebody else's commit.
      const status = yield* git(worktreePath, ["status", "--porcelain"]);
      expect(status.stdout).toContain(" M app.ts");
      expect(status.stdout).toContain("?? scratch.md");

      const head = yield* git(worktreePath, ["rev-parse", "HEAD"]);
      expect(head.stdout.trim()).toBe(published.baseCommit);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves ignored files for the setup script to rebuild", () =>
    Effect.gen(function* () {
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
      yield* fileSystem.writeFileString(path.join(laptop, ".gitignore"), ".env\n");
      yield* git(laptop, ["add", "."]);
      yield* git(laptop, ["commit", "-m", "base"]);
      yield* git(laptop, ["remote", "add", "origin", remote]);
      yield* git(laptop, ["push", "origin", "HEAD:refs/heads/main"]);

      yield* fileSystem.writeFileString(path.join(laptop, ".env"), "TOKEN=secret\n");

      const driver = yield* VcsDriver.VcsDriver;
      const published = yield* driver.checkpoints!.publishHandoffCommit({
        cwd: laptop,
        ref: handoffRefFor(HANDOFF_ID),
      });
      yield* git(laptop, [
        "push",
        "origin",
        `${handoffRefFor(HANDOFF_ID)}:${handoffRefFor(HANDOFF_ID)}`,
      ]);

      yield* git(root, ["clone", remote, desktop]);
      const worktreePath = yield* prepareHandoffWorktree({
        repositoryPath: desktop,
        worktreePath: path.join(root, "desktop-worktree"),
        branch: "slop/adopted-2",
        remoteName: "origin",
        handoffRef: handoffRefFor(HANDOFF_ID),
        baseCommit: published.baseCommit,
      });

      // A secret that never left the laptop is the point, not a limitation.
      const present = yield* fileSystem.exists(path.join(worktreePath, ".env"));
      expect(present).toBe(false);
    }).pipe(Effect.scoped),
  );
});
