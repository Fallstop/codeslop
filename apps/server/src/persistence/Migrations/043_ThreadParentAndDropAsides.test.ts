import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("043_ThreadParentAndDropAsides", (it) => {
  it.effect("links side chats to their parent and retires the aside tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Run through 42 first so the aside tables genuinely exist and the drop
      // is exercised, rather than passing because they were never created.
      yield* runMigrations({ toMigrationInclusive: 42 });
      const beforeTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'thread_aside%'
      `;
      assert.deepStrictEqual(beforeTables.map((row) => row.name).toSorted(), [
        "thread_aside_messages",
        "thread_asides",
      ]);

      yield* runMigrations({ toMigrationInclusive: 43 });

      const afterTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'thread_aside%'
      `;
      assert.deepStrictEqual(afterTables, []);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "parent_thread_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_threads_parent"));
    }),
  );

  it.effect("defaults existing threads to no parent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      // A row written by the pre-043 schema shape must read back as a root
      // thread rather than as a side chat of some unknown parent.
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, pending_approval_count, pending_user_input_count
        ) VALUES (
          'legacy-thread', 'project-1', 'Legacy', '{}', 'full-access',
          'default', NULL, NULL, NULL,
          '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z', 0, 0
        )
      `;

      const rows = yield* sql<{ readonly parent_thread_id: string | null }>`
        SELECT parent_thread_id FROM projection_threads WHERE thread_id = 'legacy-thread'
      `;
      assert.strictEqual(rows[0]?.parent_thread_id ?? null, null);
    }),
  );
});
