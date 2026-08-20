// @effect-diagnostics nodeBuiltinImport:off - builds real state-home layouts on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  preferInitializedStateHome,
  resolveUserStateHome,
  stateHomeDatabaseCandidates,
  userStateHomeCandidates,
  worktreeStateHomeCandidates,
} from "./stateHome.ts";

const join: (first: string, ...rest: string[]) => string = NodePath.posix.join;

describe("preferInitializedStateHome", () => {
  it("keeps a machine that has already moved to the current name", () => {
    assert.equal(
      preferInitializedStateHome({
        current: "/home/alice/.codeslop",
        legacy: "/home/alice/.t3",
        currentIsInitialized: true,
        legacyIsInitialized: true,
      }),
      "/home/alice/.codeslop",
    );
  });

  it("keeps a pre-rebrand install on the home that holds its state", () => {
    assert.equal(
      preferInitializedStateHome({
        current: "/home/alice/.codeslop",
        legacy: "/home/alice/.t3",
        currentIsInitialized: false,
        legacyIsInitialized: true,
      }),
      "/home/alice/.t3",
    );
  });

  it("gives a fresh machine the current name", () => {
    assert.equal(
      preferInitializedStateHome({
        current: "/home/alice/.codeslop",
        legacy: "/home/alice/.t3",
        currentIsInitialized: false,
        legacyIsInitialized: false,
      }),
      "/home/alice/.codeslop",
    );
  });
});

describe("state home candidates", () => {
  it("probes both the userdata and dev databases", () => {
    assert.deepEqual(stateHomeDatabaseCandidates("/home/alice/.codeslop", join), [
      "/home/alice/.codeslop/userdata/state.sqlite",
      "/home/alice/.codeslop/dev/state.sqlite",
    ]);
  });

  it("names the user and worktree pairs", () => {
    assert.deepEqual(userStateHomeCandidates("/home/alice", join), {
      current: "/home/alice/.codeslop",
      legacy: "/home/alice/.t3",
    });
    assert.deepEqual(worktreeStateHomeCandidates("/repo/wt", join), {
      current: "/repo/wt/.slop",
      legacy: "/repo/wt/.t3",
    });
  });
});

const writeStateDatabase = (baseDir: string, stateDir: "userdata" | "dev") => {
  NodeFS.mkdirSync(NodePath.join(baseDir, stateDir), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(baseDir, stateDir, "state.sqlite"), "");
};

describe("resolveUserStateHome", () => {
  const scenario = (
    name: string,
    setup: (home: string) => void,
    expected: (home: string) => string,
  ) =>
    it.effect(name, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-state-home-test-" });
        setup(home);
        assert.equal(yield* resolveUserStateHome(home), expected(home));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

  scenario(
    "picks .codeslop on a fresh machine",
    () => {},
    (home) => NodePath.join(home, ".codeslop"),
  );

  scenario(
    "picks the pre-rebrand home when it is the one holding state",
    (home) => writeStateDatabase(NodePath.join(home, ".t3"), "userdata"),
    (home) => NodePath.join(home, ".t3"),
  );

  // The case that split m3 in two: both directories present, and every component
  // has to agree on which one is live.
  scenario(
    "prefers .codeslop when both homes hold a database",
    (home) => {
      writeStateDatabase(NodePath.join(home, ".t3"), "userdata");
      writeStateDatabase(NodePath.join(home, ".codeslop"), "userdata");
    },
    (home) => NodePath.join(home, ".codeslop"),
  );

  // An empty ~/.codeslop gets created as a side effect often enough that its mere
  // presence must not win.
  scenario(
    "ignores an empty .codeslop directory",
    (home) => {
      NodeFS.mkdirSync(NodePath.join(home, ".codeslop"), { recursive: true });
      writeStateDatabase(NodePath.join(home, ".t3"), "userdata");
    },
    (home) => NodePath.join(home, ".t3"),
  );

  scenario(
    "counts a database kept under dev/",
    (home) => writeStateDatabase(NodePath.join(home, ".t3"), "dev"),
    (home) => NodePath.join(home, ".t3"),
  );
});
