import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  exportCodexSession,
  findCodexRolloutPath,
  installCodexSession,
} from "./CodexSessionTransfer.ts";

const THREAD_ID = "01a02244-c54a-7602-ae41-8c6c4721451d";
const ROLLOUT_NAME = `rollout-2026-08-21T15-02-07-${THREAD_ID}.jsonl`;

const makeHome = Effect.fn("makeHome")(function* (nestedDatePath: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped();
  const directory = path.join(home, "sessions", ...nestedDatePath);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, ROLLOUT_NAME),
    `{"type":"session_meta","payload":{"session_id":"${THREAD_ID}","cwd":"/origin/repo"}}\n`,
  );
  return home;
});

it.layer(NodeServices.layer)("codex session transfer", (it) => {
  it.effect("finds a rollout under its date directory", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(["2026", "08", "21"]);
      const found = yield* findCodexRolloutPath({ codexHome: home, threadId: THREAD_ID });
      assert.isNotNull(found);
      expect(found).toContain(ROLLOUT_NAME);
    }).pipe(Effect.scoped),
  );

  it.effect("finds a rollout filed under the wrong date", () =>
    Effect.gen(function* () {
      // Verified against codex-cli 0.149.0: resume succeeds regardless of the
      // date directory, so discovery must not compute one.
      const home = yield* makeHome(["1999", "01", "02"]);
      const found = yield* findCodexRolloutPath({ codexHome: home, threadId: THREAD_ID });
      assert.isNotNull(found);
    }).pipe(Effect.scoped),
  );

  it.effect("round-trips a rollout into another home, bytes untouched", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const source = yield* makeHome(["2026", "08", "21"]);
      const target = yield* fileSystem.makeTempDirectoryScoped();

      const exported = yield* exportCodexSession({ codexHome: source, threadId: THREAD_ID });
      assert.isNotNull(exported);
      expect(exported!.fileName).toBe(ROLLOUT_NAME);

      yield* installCodexSession({
        codexHome: target,
        fileName: exported!.fileName,
        bytes: exported!.bytes,
      });

      // Discoverable on the far side, and the origin cwd is deliberately still
      // recorded: resume takes its cwd from the caller.
      const found = yield* findCodexRolloutPath({ codexHome: target, threadId: THREAD_ID });
      assert.isNotNull(found);
      const landed = yield* fileSystem.readFileString(found!);
      expect(landed).toContain('"cwd":"/origin/repo"');
    }).pipe(Effect.scoped),
  );

  it.effect("reports a missing rollout instead of failing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const exported = yield* exportCodexSession({ codexHome: home, threadId: THREAD_ID });
      expect(exported).toBeNull();
    }).pipe(Effect.scoped),
  );
});
