import * as NodeServices from "@effect/platform-node/NodeServices";
import { HandoffId, ThreadId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  HANDOFF_CHUNK_BYTES,
  HandoffStagingStore,
  layer as stagingLayer,
  sha256,
  type HandoffBundleManifest,
} from "./HandoffStagingStore.ts";

const TestLayer = stagingLayer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-staging-" })),
  Layer.provideMerge(NodeServices.layer),
);

const HANDOFF_ID = HandoffId.make("handoff-1");

const manifest = (bytes: Uint8Array): HandoffBundleManifest => ({
  handoffId: HANDOFF_ID,
  provider: "claudeAgent",
  sessionId: "f3dc0e7f-71e7-4b8f-b976-6fd0ca77ae00",
  sessionSha256: sha256(bytes),
  sessionBytes: bytes.length,
  originEnvironmentId: "env-laptop",
  originThreadId: ThreadId.make("thread-1"),
  targetThreadId: ThreadId.make("thread-2"),
  originStoppedAt: "2026-08-21T00:00:00.000Z",
});

it.layer(TestLayer)("handoff staging store", (it) => {
  it.effect("round-trips a manifest", () =>
    Effect.gen(function* () {
      const store = yield* HandoffStagingStore;
      const bytes = new TextEncoder().encode("session\n");
      yield* store.writeManifest({ handoffId: HANDOFF_ID, manifest: manifest(bytes) });

      const read = yield* store.readManifest({ handoffId: HANDOFF_ID });
      assert.isNotNull(read);
      expect(read!.sessionSha256).toBe(sha256(bytes));
      expect(read!.originStoppedAt).toBe("2026-08-21T00:00:00.000Z");
    }),
  );

  it.effect("reports a missing bundle rather than failing", () =>
    Effect.gen(function* () {
      const store = yield* HandoffStagingStore;
      // Callers turn this into a typed refusal; a defect here would take the
      // whole RPC down instead.
      const read = yield* store.readManifest({ handoffId: HandoffId.make("never-staged") });
      expect(read).toBeNull();
      const chunk = yield* store.readSessionChunk({
        handoffId: HandoffId.make("never-staged"),
        offset: 0,
        length: 16,
      });
      expect(chunk).toBeNull();
    }),
  );

  it.effect("reassembles a session from offset-addressed chunks", () =>
    Effect.gen(function* () {
      const store = yield* HandoffStagingStore;
      const source = new Uint8Array(HANDOFF_CHUNK_BYTES + 1024);
      for (let index = 0; index < source.length; index += 1) {
        source[index] = index % 251;
      }
      yield* store.writeSession({ handoffId: HANDOFF_ID, bytes: source });

      // Read it out the way the courier does, then write it back into a second
      // bundle the way the target does.
      const target = HandoffId.make("handoff-2");
      let offset = 0;
      for (;;) {
        const chunk = yield* store.readSessionChunk({
          handoffId: HANDOFF_ID,
          offset,
          length: HANDOFF_CHUNK_BYTES,
        });
        assert.isNotNull(chunk);
        if (chunk!.bytes.length === 0) {
          break;
        }
        yield* store.appendSession({ handoffId: target, offset, bytes: chunk!.bytes });
        offset += chunk!.bytes.length;
        if (offset >= chunk!.totalBytes) {
          break;
        }
      }

      const landed = yield* store.readSession({ handoffId: target });
      assert.isNotNull(landed);
      expect(landed!.length).toBe(source.length);
      expect(sha256(landed!)).toBe(sha256(source));
    }),
  );

  it.effect("a replayed chunk overwrites rather than duplicating", () =>
    Effect.gen(function* () {
      const store = yield* HandoffStagingStore;
      const target = HandoffId.make("handoff-retry");
      const first = new TextEncoder().encode("AAAA");
      const second = new TextEncoder().encode("BBBB");

      yield* store.appendSession({ handoffId: target, offset: 0, bytes: first });
      yield* store.appendSession({ handoffId: target, offset: 4, bytes: second });
      // The courier retries this chunk after a dropped connection.
      yield* store.appendSession({ handoffId: target, offset: 4, bytes: second });

      const landed = yield* store.readSession({ handoffId: target });
      expect(new TextDecoder().decode(landed!)).toBe("AAAABBBB");
    }),
  );

  it.effect("discards a bundle completely", () =>
    Effect.gen(function* () {
      const store = yield* HandoffStagingStore;
      const bytes = new TextEncoder().encode("session\n");
      yield* store.writeManifest({ handoffId: HANDOFF_ID, manifest: manifest(bytes) });
      yield* store.writeSession({ handoffId: HANDOFF_ID, bytes });

      yield* store.discard({ handoffId: HANDOFF_ID });

      expect(yield* store.readManifest({ handoffId: HANDOFF_ID })).toBeNull();
      expect(yield* store.readSession({ handoffId: HANDOFF_ID })).toBeNull();
    }),
  );
});
