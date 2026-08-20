// @effect-diagnostics nodeBuiltinImport:off - joins paths for a pure resolver under test.
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as NodePath from "node:path";

import { resolveDesktopBaseDir, resolveDesktopStateDir } from "./DesktopStatePaths.ts";

const joinPath: (first: string, ...rest: string[]) => string = NodePath.posix.join;
const HOME = "/Users/alice";

/** Stands in for the databases each candidate home would hold. */
const withDatabasesIn = (...baseDirs: ReadonlyArray<string>) => {
  const present = new Set(baseDirs.map((baseDir) => joinPath(baseDir, "userdata", "state.sqlite")));
  return (path: string) => present.has(path);
};

const resolve = (fileExists: (path: string) => boolean, t3Home = Option.none<string>()) =>
  resolveDesktopBaseDir({ homeDirectory: HOME, joinPath, t3Home, fileExists });

describe("resolveDesktopBaseDir", () => {
  it("picks .codeslop on a fresh machine", () => {
    assert.equal(
      resolve(() => false),
      `${HOME}/.codeslop`,
    );
  });

  // Before this rule the desktop went straight to .codeslop while the CLI and the
  // SSH launcher stayed on .t3, so one machine served two different databases.
  it("follows a pre-rebrand .t3 that holds the database", () => {
    assert.equal(resolve(withDatabasesIn(`${HOME}/.t3`)), `${HOME}/.t3`);
  });

  it("prefers .codeslop once it holds a database too", () => {
    assert.equal(resolve(withDatabasesIn(`${HOME}/.t3`, `${HOME}/.codeslop`)), `${HOME}/.codeslop`);
  });

  it("ignores a .t3 directory that never held state", () => {
    assert.equal(
      resolve((path) => path.startsWith(`${HOME}/.t3`) && !path.endsWith("state.sqlite")),
      `${HOME}/.codeslop`,
    );
  });

  it("counts a database kept under dev/", () => {
    assert.equal(
      resolve((path) => path === `${HOME}/.t3/dev/state.sqlite`),
      `${HOME}/.t3`,
    );
  });

  it("an explicit T3CODE_HOME wins without probing anything", () => {
    let probed = false;
    const baseDir = resolveDesktopBaseDir({
      homeDirectory: HOME,
      joinPath,
      t3Home: Option.some("  /tmp/explicit  "),
      fileExists: () => {
        probed = true;
        return true;
      },
    });
    assert.equal(baseDir, "/tmp/explicit");
    assert.isFalse(probed);
  });

  it("treats a blank T3CODE_HOME as unset", () => {
    assert.equal(
      resolve(() => false, Option.some("   ")),
      `${HOME}/.codeslop`,
    );
  });
});

describe("resolveDesktopStateDir", () => {
  it("uses dev only when development runs without an explicit home", () => {
    const baseDir = `${HOME}/.codeslop`;
    assert.equal(
      resolveDesktopStateDir({
        baseDir,
        isDevelopment: true,
        joinPath,
        t3Home: Option.none(),
      }),
      `${baseDir}/dev`,
    );
    assert.equal(
      resolveDesktopStateDir({
        baseDir,
        isDevelopment: true,
        joinPath,
        t3Home: Option.some("/tmp/explicit"),
      }),
      `${baseDir}/userdata`,
    );
    assert.equal(
      resolveDesktopStateDir({
        baseDir,
        isDevelopment: false,
        joinPath,
        t3Home: Option.none(),
      }),
      `${baseDir}/userdata`,
    );
  });
});
