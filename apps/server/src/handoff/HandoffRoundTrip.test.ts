import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeProjectSlug } from "../provider/Drivers/ClaudeSessionTransfer.ts";
import {
  exportHandoffSession,
  installHandoffSession,
  type HandoffSessionLocation,
} from "./HandoffSessionTransfer.ts";
import { makeHandoffResumeCursor, readHandoffSessionId } from "./HandoffSessionCursor.ts";
import { sha256 } from "./HandoffStagingStore.ts";

const CLAUDE_SESSION = "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00";
const CODEX_THREAD = "01a02244-c54a-7602-ae41-8c6c4721451d";

/** Move a session from one machine to another, the way a handoff does. */
const hop = Effect.fn("hop")(function* (input: {
  readonly from: HandoffSessionLocation;
  readonly to: HandoffSessionLocation;
  readonly fileName?: string | undefined;
}) {
  const exported = yield* exportHandoffSession(input.from);
  assert.isNotNull(exported);
  yield* installHandoffSession({
    ...input.to,
    bytes: exported!.bytes,
    ...(exported!.fileName !== undefined ? { fileName: exported!.fileName } : {}),
  });
  return exported!;
});

it.layer(NodeServices.layer)("handoff round trip", (it) => {
  it.effect("a claude session survives laptop to desktop and back", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();

      const laptopHome = path.join(root, "laptop-claude");
      const desktopHome = path.join(root, "desktop-claude");
      const laptopCwd = path.join(root, "laptop-repo");
      const desktopCwd = path.join(root, "desktop-repo");
      yield* fileSystem.makeDirectory(laptopCwd, { recursive: true });
      yield* fileSystem.makeDirectory(desktopCwd, { recursive: true });

      const transcript = new TextEncoder().encode(
        `{"type":"user","sessionId":"${CLAUDE_SESSION}","cwd":"${laptopCwd}"}\n`,
      );
      const original = sha256(transcript);

      const onLaptop = {
        provider: "claudeAgent",
        providerHome: laptopHome,
        sessionId: CLAUDE_SESSION,
        cwd: laptopCwd,
      } as const satisfies HandoffSessionLocation;
      const onDesktop = {
        provider: "claudeAgent",
        providerHome: desktopHome,
        sessionId: CLAUDE_SESSION,
        cwd: desktopCwd,
      } as const satisfies HandoffSessionLocation;

      yield* installHandoffSession({ ...onLaptop, bytes: transcript });

      // Hop one: laptop to desktop.
      yield* hop({ from: onLaptop, to: onDesktop });
      const afterFirst = yield* fileSystem.readFile(
        path.join(
          desktopHome,
          "projects",
          claudeProjectSlug(
            yield* fileSystem.realPath(desktopCwd).pipe(Effect.orElseSucceed(() => desktopCwd)),
          ),
          `${CLAUDE_SESSION}.jsonl`,
        ),
      );
      expect(sha256(afterFirst)).toBe(original);

      // Hop two: hand it back. This is the case that breaks if a transported
      // session is not a real local session on the machine that received it.
      yield* hop({ from: onDesktop, to: onLaptop });
      const afterSecond = yield* fileSystem.readFile(
        path.join(
          laptopHome,
          "projects",
          claudeProjectSlug(
            yield* fileSystem.realPath(laptopCwd).pipe(Effect.orElseSucceed(() => laptopCwd)),
          ),
          `${CLAUDE_SESSION}.jsonl`,
        ),
      );
      expect(sha256(afterSecond)).toBe(original);

      // The id never changes across hops, so nothing accumulates a second copy
      // under a second identity.
      const laptopProjects = yield* fileSystem.readDirectory(path.join(laptopHome, "projects"));
      expect(laptopProjects.length).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a codex rollout survives both hops keeping its filename", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();

      const laptopHome = path.join(root, "laptop-codex");
      const desktopHome = path.join(root, "desktop-codex");
      const fileName = `rollout-2026-08-21T15-02-07-${CODEX_THREAD}.jsonl`;
      const rollout = new TextEncoder().encode(
        `{"type":"session_meta","payload":{"session_id":"${CODEX_THREAD}"}}\n`,
      );

      const onLaptop = {
        provider: "codex",
        providerHome: laptopHome,
        sessionId: CODEX_THREAD,
        cwd: root,
      } as const satisfies HandoffSessionLocation;
      const onDesktop = {
        provider: "codex",
        providerHome: desktopHome,
        sessionId: CODEX_THREAD,
        cwd: root,
      } as const satisfies HandoffSessionLocation;

      yield* installHandoffSession({ ...onLaptop, bytes: rollout, fileName });

      const first = yield* hop({ from: onLaptop, to: onDesktop });
      expect(first.fileName).toBe(fileName);

      const second = yield* hop({ from: onDesktop, to: onLaptop });
      // Resume matches on the id inside the filename, so it must not drift on
      // the way back either.
      expect(second.fileName).toBe(fileName);
      expect(sha256(second.bytes)).toBe(sha256(rollout));
    }).pipe(Effect.scoped),
  );

  it("the cursor written on adopt reads back as the session that was moved", () => {
    // The round trip that matters most: what adopt seeds must be what a later
    // export reads, or handing back would carry the wrong id.
    for (const provider of ["claudeAgent", "codex"] as const) {
      const sessionId = provider === "claudeAgent" ? CLAUDE_SESSION : CODEX_THREAD;
      const cursor = makeHandoffResumeCursor({
        provider,
        threadId: "thread-on-target",
        sessionId,
      });
      expect(readHandoffSessionId(provider, cursor)).toBe(sessionId);
    }
  });
});
