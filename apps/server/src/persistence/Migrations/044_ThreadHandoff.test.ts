import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ThreadHandoff", (it) => {
  it.effect("adds both ends of the handoff link and the in-flight column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = columns.map((column) => column.name);
      assert.ok(names.includes("handed_off_to_json"));
      assert.ok(names.includes("continued_from_json"));
      assert.ok(names.includes("handoff_pending_json"));
    }),
  );

  it.effect("leaves existing threads owned by this environment", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });

      // A row written by the pre-044 schema must read back as a thread that
      // never left this machine. Anything else would trip the decider's
      // split-brain guard and wedge every pre-existing thread.
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, pending_approval_count, pending_user_input_count
        ) VALUES (
          'legacy-thread', 'project-1', 'Legacy', '{}', 'full-access',
          'default', NULL, NULL, NULL,
          '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z', 0, 0
        )
      `;

      const rows = yield* sql<{
        readonly handed_off_to_json: string | null;
        readonly continued_from_json: string | null;
        readonly handoff_pending_json: string | null;
      }>`
        SELECT handed_off_to_json, continued_from_json, handoff_pending_json
        FROM projection_threads WHERE thread_id = 'legacy-thread'
      `;
      assert.strictEqual(rows[0]?.handed_off_to_json ?? null, null);
      assert.strictEqual(rows[0]?.continued_from_json ?? null, null);
      assert.strictEqual(rows[0]?.handoff_pending_json ?? null, null);
    }),
  );
});
