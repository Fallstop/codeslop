import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type { ProviderAdapterV2NativeSessionTransfer } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

const TestLayer = Layer.mergeAll(
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-transfer-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const claudeTransfer = (homePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const unused = Effect.die("unused");
    const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath },
      environment: {},
      attachmentsDir: homePath,
      fileSystem,
      path: yield* Path.Path,
      crypto: undefined as never,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: unused,
        open: () => unused,
        forkSession: () => unused,
        subagentLaunchToolUseId: () => unused,
        assertComplete: unused,
      },
    });
    return adapter.nativeSessionTransfer!;
  });

const codexTransfer = (homePath: string) =>
  Effect.gen(function* () {
    const adapter = CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory: { open: () => Effect.die("unused") },
      crypto: undefined as never,
      fileSystem: yield* FileSystem.FileSystem,
      nativeSessions: { homePath, path: yield* Path.Path },
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
    });
    return adapter.nativeSessionTransfer!;
  });

/** Moves a session from one machine's home and workspace to another's. */
const hop = (
  from: { transfer: ProviderAdapterV2NativeSessionTransfer; cwd: string },
  to: { transfer: ProviderAdapterV2NativeSessionTransfer; cwd: string },
  nativeThreadId: string,
) =>
  Effect.gen(function* () {
    const session = yield* from.transfer.export({ nativeThreadId, cwd: from.cwd });
    assert.isNotNull(session);
    yield* to.transfer.install({ nativeThreadId, cwd: to.cwd, session: session! });
    return session!;
  });

it.layer(TestLayer)("native session transfer", (it) => {
  it.effect("a Claude session resumes from the other machine's worktree and back", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const laptop = { home: path.join(root, "laptop"), cwd: path.join(root, "laptop-repo") };
      const desktop = { home: path.join(root, "desktop"), cwd: path.join(root, "desktop-repo") };
      yield* fileSystem.makeDirectory(laptop.cwd, { recursive: true });
      yield* fileSystem.makeDirectory(desktop.cwd, { recursive: true });
      const sessionId = "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00";
      const onLaptop = { transfer: yield* claudeTransfer(laptop.home), cwd: laptop.cwd };
      const onDesktop = { transfer: yield* claudeTransfer(desktop.home), cwd: desktop.cwd };

      assert.isNull(
        yield* onLaptop.transfer.export({ nativeThreadId: sessionId, cwd: laptop.cwd }),
      );
      const transcript = new TextEncoder().encode(`{"type":"user","sessionId":"${sessionId}"}\n`);
      yield* onLaptop.transfer.install({
        nativeThreadId: sessionId,
        cwd: laptop.cwd,
        session: { bytes: transcript, fileName: null },
      });

      const there = yield* hop(onLaptop, onDesktop, sessionId);
      const back = yield* hop(onDesktop, onLaptop, sessionId);
      assert.deepEqual(back.bytes, there.bytes);
      assert.deepEqual(back.bytes, transcript);
    }).pipe(Effect.scoped),
  );

  it.effect("a Codex rollout keeps the filename resume looks it up by", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const threadId = "01a02244-c54a-7602-ae41-8c6c4721451d";
      const fileName = `rollout-2026-08-21T15-02-07-${threadId}.jsonl`;
      const laptopHome = path.join(root, "laptop");
      yield* fileSystem.makeDirectory(path.join(laptopHome, "sessions", "2026", "08", "21"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(laptopHome, "sessions", "2026", "08", "21", fileName),
        `{"type":"session_meta"}\n`,
      );
      const onLaptop = { transfer: yield* codexTransfer(laptopHome), cwd: root };
      const onDesktop = { transfer: yield* codexTransfer(path.join(root, "desktop")), cwd: root };

      const there = yield* hop(onLaptop, onDesktop, threadId);
      assert.equal(there.fileName, fileName);
      const back = yield* hop(onDesktop, onLaptop, threadId);
      assert.equal(back.fileName, fileName);
    }).pipe(Effect.scoped),
  );
});
