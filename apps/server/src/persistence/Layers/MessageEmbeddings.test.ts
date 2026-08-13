import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { MessageEmbeddingRepositoryLive } from "./MessageEmbeddings.ts";
import { MessageEmbeddingRepository } from "../Services/MessageEmbeddings.ts";
import { packEmbedding } from "../../semanticSearch/embeddingText.ts";

const MODEL = "test-model";

const repositoryLayer = it.layer(
  MessageEmbeddingRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const seedProjections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM message_embeddings`;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_turns`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (
      'project-1', 'Project', '/tmp/project-1',
      '{"provider":"codex","model":"gpt-5-codex"}', '[]',
      '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:01.000Z', NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, latest_turn_id,
      latest_user_message_at, pending_approval_count, pending_user_input_count,
      has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
    )
    VALUES
      (
        'thread-active', 'project-1', 'Active', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', NULL, NULL, 'turn-1', NULL, 0, 0, 0,
        '2026-05-01T00:00:02.000Z', '2026-05-01T00:00:03.000Z', NULL, NULL
      ),
      (
        'thread-archived', 'project-1', 'Archived', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
        '2026-05-01T00:00:04.000Z', '2026-05-01T00:00:05.000Z',
        '2026-05-01T00:00:06.000Z', NULL
      ),
      (
        'thread-deleted', 'project-1', 'Deleted', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
        '2026-05-01T00:00:07.000Z', '2026-05-01T00:00:08.000Z', NULL,
        '2026-05-01T00:00:09.000Z'
      )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    )
    VALUES
      ('msg-user', 'thread-active', 'turn-1', 'user', 'How do I rotate the API keys?', 0,
        '2026-05-01T00:00:10.000Z', '2026-05-01T00:00:10.000Z'),
      ('msg-assistant', 'thread-active', 'turn-1', 'assistant', 'Rotate them in the settings page.', 0,
        '2026-05-01T00:00:11.000Z', '2026-05-01T00:00:11.000Z'),
      ('msg-interim', 'thread-active', 'turn-1', 'assistant', 'Interim reasoning text.', 0,
        '2026-05-01T00:00:12.000Z', '2026-05-01T00:00:12.000Z'),
      ('msg-streaming', 'thread-active', NULL, 'user', 'still typing', 1,
        '2026-05-01T00:00:13.000Z', '2026-05-01T00:00:13.000Z'),
      ('msg-system', 'thread-active', NULL, 'system', 'system prompt', 0,
        '2026-05-01T00:00:14.000Z', '2026-05-01T00:00:14.000Z'),
      ('msg-archived', 'thread-archived', NULL, 'user', 'archived question', 0,
        '2026-05-01T00:00:15.000Z', '2026-05-01T00:00:15.000Z'),
      ('msg-deleted', 'thread-deleted', NULL, 'user', 'deleted question', 0,
        '2026-05-01T00:00:16.000Z', '2026-05-01T00:00:16.000Z')
  `;

  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, assistant_message_id, state,
      requested_at, started_at, completed_at, checkpoint_files_json
    )
    VALUES (
      'thread-active', 'turn-1', 'msg-user', 'msg-assistant', 'completed',
      '2026-05-01T00:00:10.000Z', '2026-05-01T00:00:10.000Z',
      '2026-05-01T00:00:11.000Z', '[]'
    )
  `;
});

const vectorOf = (values: ReadonlyArray<number>) => packEmbedding(Float32Array.from(values));

repositoryLayer("MessageEmbeddingRepository", (it) => {
  it.effect("lists stale messages mirroring the lexical search population", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      const stale = yield* repository.listStaleMessages({ model: MODEL, limit: 50 });
      const staleIds = stale.map((message) => message.messageId).toSorted();
      // user + canonical assistant of active and archived threads; interim
      // assistant output, streaming, system, and deleted threads excluded.
      assert.deepStrictEqual(staleIds, ["msg-archived", "msg-assistant", "msg-user"]);
    }),
  );

  it.effect("replaceForMessage clears staleness, including for empty chunk sets", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      yield* repository.replaceForMessage({
        messageId: MessageId.make("msg-user"),
        threadId: ThreadId.make("thread-active"),
        model: MODEL,
        messageUpdatedAt: "2026-05-01T00:00:10.000Z",
        updatedAt: "2026-05-01T00:01:00.000Z",
        chunks: [
          { chunkIndex: 0, chunkText: "How do I rotate the API keys?", vector: vectorOf([1, 0]) },
        ],
      });
      // No embeddable text: a sentinel row is written instead.
      yield* repository.replaceForMessage({
        messageId: MessageId.make("msg-assistant"),
        threadId: ThreadId.make("thread-active"),
        model: MODEL,
        messageUpdatedAt: "2026-05-01T00:00:11.000Z",
        updatedAt: "2026-05-01T00:01:00.000Z",
        chunks: [],
      });

      const stale = yield* repository.listStaleMessages({ model: MODEL, limit: 50 });
      assert.deepStrictEqual(
        stale.map((message) => message.messageId),
        [MessageId.make("msg-archived")],
      );

      // A message edit (updated_at change) makes it stale again.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_thread_messages
        SET updated_at = '2026-05-01T00:02:00.000Z'
        WHERE message_id = 'msg-user'
      `;
      const staleAfterEdit = yield* repository.listStaleMessages({ model: MODEL, limit: 50 });
      assert.isTrue(
        staleAfterEdit.some((message) => message.messageId === MessageId.make("msg-user")),
      );

      // Sentinel rows are not returned as searchable vectors.
      const vectors = yield* repository.listVectors({ model: MODEL });
      assert.deepStrictEqual(
        vectors.map((vector) => vector.messageId),
        [MessageId.make("msg-user")],
      );
    }),
  );

  it.effect("listMatchMetadata joins active threads only", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      for (const [messageId, threadId, text] of [
        ["msg-user", "thread-active", "How do I rotate the API keys?"],
        ["msg-archived", "thread-archived", "archived question"],
        ["msg-deleted", "thread-deleted", "deleted question"],
      ] as const) {
        yield* repository.replaceForMessage({
          messageId: MessageId.make(messageId),
          threadId: ThreadId.make(threadId),
          model: MODEL,
          messageUpdatedAt: "2026-05-01T00:00:10.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          chunks: [{ chunkIndex: 0, chunkText: text, vector: vectorOf([1, 0]) }],
        });
      }

      const metadata = yield* repository.listMatchMetadata({
        model: MODEL,
        messageIds: [
          MessageId.make("msg-user"),
          MessageId.make("msg-archived"),
          MessageId.make("msg-deleted"),
        ],
      });
      assert.deepStrictEqual(
        metadata.map((row) => [row.messageId, row.source, row.chunkText]),
        [[MessageId.make("msg-user"), "user", "How do I rotate the API keys?"]],
      );
    }),
  );

  it.effect("deleteOrphaned removes rows for deleted threads and vanished messages", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      for (const [messageId, threadId] of [
        ["msg-user", "thread-active"],
        ["msg-deleted", "thread-deleted"],
        ["msg-gone", "thread-active"],
      ] as const) {
        yield* repository.replaceForMessage({
          messageId: MessageId.make(messageId),
          threadId: ThreadId.make(threadId),
          model: MODEL,
          messageUpdatedAt: "2026-05-01T00:00:10.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          chunks: [{ chunkIndex: 0, chunkText: "text", vector: vectorOf([1, 0]) }],
        });
      }

      const removed = yield* repository.deleteOrphaned({ model: MODEL });
      assert.deepStrictEqual(removed.toSorted(), [
        MessageId.make("msg-deleted"),
        MessageId.make("msg-gone"),
      ]);

      const vectors = yield* repository.listVectors({ model: MODEL });
      assert.deepStrictEqual(
        vectors.map((vector) => vector.messageId),
        [MessageId.make("msg-user")],
      );
    }),
  );
});
