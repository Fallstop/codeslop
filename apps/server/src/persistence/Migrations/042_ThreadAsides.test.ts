import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AsideId, AsideMessageId, ThreadId } from "@t3tools/contracts";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ThreadAsideRepositoryLive } from "../Layers/ThreadAsides.ts";
import { ThreadAsideRepository } from "../Services/ThreadAsides.ts";

const layer = it.layer(
  ThreadAsideRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const AT = "2026-08-14T00:00:00.000Z";

/**
 * The layer opens one in-memory database for the whole block, so each test
 * namespaces its own rows rather than sharing an "aside-1".
 */
const scope = (name: string) => ({
  thread: ThreadId.make(`${name}-thread`),
  otherThread: ThreadId.make(`${name}-other-thread`),
  aside: (suffix: string) => AsideId.make(`${name}-${suffix}`),
});

const header = (asideId: AsideId, threadId: ThreadId) => ({
  asideId,
  threadId,
  turnId: null,
  title: "why that order?",
  fidelity: "session" as const,
  createdAt: AT,
  updatedAt: AT,
});

const messageRow = (
  asideId: AsideId,
  sequence: number,
  role: "user" | "assistant",
  text: string,
  synthetic = false,
) => ({
  asideMessageId: AsideMessageId.make(`${asideId}-${sequence}`),
  asideId,
  sequence,
  role,
  text,
  synthetic,
  createdAt: AT,
});

layer("042_ThreadAsides", (it) => {
  it.effect("round-trips an aside and its messages in sequence order", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      const repository = yield* ThreadAsideRepository;
      const ids = scope("roundtrip");
      const asideId = ids.aside("a");

      yield* repository.insert(header(asideId, ids.thread));
      // Appended out of order to prove the read path sorts rather than relying
      // on insertion order.
      yield* repository.appendMessage(messageRow(asideId, 1, "assistant", "because of X"), {
        asideId,
        updatedAt: "2026-08-14T00:00:02.000Z",
      });
      yield* repository.appendMessage(messageRow(asideId, 0, "user", "why that order?"), {
        asideId,
        updatedAt: "2026-08-14T00:00:01.000Z",
      });

      const messages = yield* repository.listMessagesByAsideId({ asideId });
      assert.deepStrictEqual(
        messages.map((message) => [message.sequence, message.role, message.text]),
        [
          [0, "user", "why that order?"],
          [1, "assistant", "because of X"],
        ],
      );

      // appendMessage stamps the parent, so the header tracks the last write.
      const stored = yield* repository.get({ asideId });
      assert.ok(Option.isSome(stored));
      assert.strictEqual(stored.value.updatedAt, "2026-08-14T00:00:01.000Z");
    }),
  );

  it.effect("round-trips the synthetic flag through SQLite's integer boolean", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      const repository = yield* ThreadAsideRepository;
      const ids = scope("synthetic");
      const asideId = ids.aside("a");

      yield* repository.insert(header(asideId, ids.thread));
      yield* repository.appendMessage(
        messageRow(asideId, 0, "assistant", "tried to call a tool", true),
        { asideId, updatedAt: AT },
      );

      const messages = yield* repository.listMessagesByAsideId({ asideId });
      assert.strictEqual(messages[0]?.synthetic, true);
    }),
  );

  it.effect("scopes listing to one thread", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      const repository = yield* ThreadAsideRepository;
      const ids = scope("scoping");
      const mine = ids.aside("a");
      const theirs = ids.aside("b");

      yield* repository.insert(header(mine, ids.thread));
      yield* repository.insert(header(theirs, ids.otherThread));
      yield* repository.appendMessage(messageRow(theirs, 0, "user", "other thread"), {
        asideId: theirs,
        updatedAt: AT,
      });

      const asides = yield* repository.listByThreadId({ threadId: ids.thread });
      assert.deepStrictEqual(
        asides.map((aside) => aside.asideId),
        [mine],
      );
      // The other thread's message must not leak through the join.
      const messages = yield* repository.listMessagesByThreadId({ threadId: ids.thread });
      assert.strictEqual(messages.length, 0);
    }),
  );

  it.effect("records a fidelity downgrade", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      const repository = yield* ThreadAsideRepository;
      const ids = scope("fidelity");
      const asideId = ids.aside("a");

      yield* repository.insert(header(asideId, ids.thread));
      yield* repository.setFidelity({ asideId, fidelity: "transcript" });

      const stored = yield* repository.get({ asideId });
      assert.ok(Option.isSome(stored));
      assert.strictEqual(stored.value.fidelity, "transcript");
    }),
  );

  it.effect("deleting an aside takes its messages with it", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      const repository = yield* ThreadAsideRepository;
      const ids = scope("delete-one");
      const asideId = ids.aside("a");

      yield* repository.insert(header(asideId, ids.thread));
      yield* repository.appendMessage(messageRow(asideId, 0, "user", "why?"), {
        asideId,
        updatedAt: AT,
      });
      yield* repository.deleteById({ asideId });

      assert.ok(Option.isNone(yield* repository.get({ asideId })));
      const messages = yield* repository.listMessagesByThreadId({ threadId: ids.thread });
      assert.strictEqual(messages.length, 0);
    }),
  );

  it.effect("deleting a thread's asides clears every aside on it", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      const repository = yield* ThreadAsideRepository;
      const ids = scope("delete-thread");
      const first = ids.aside("a");
      const second = ids.aside("b");
      const elsewhere = ids.aside("c");

      yield* repository.insert(header(first, ids.thread));
      yield* repository.insert(header(second, ids.thread));
      yield* repository.insert(header(elsewhere, ids.otherThread));
      yield* repository.appendMessage(messageRow(first, 0, "user", "why?"), {
        asideId: first,
        updatedAt: AT,
      });

      yield* repository.deleteByThreadId({ threadId: ids.thread });

      assert.strictEqual((yield* repository.listByThreadId({ threadId: ids.thread })).length, 0);
      assert.strictEqual(
        (yield* repository.listMessagesByThreadId({ threadId: ids.thread })).length,
        0,
      );
      assert.strictEqual(
        (yield* repository.listByThreadId({ threadId: ids.otherThread })).length,
        1,
      );
    }),
  );
});
