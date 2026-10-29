import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

const seedCodeslopHistory = Effect.fn("seedCodeslopHistory")(function* (throughId: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: Math.max(40, throughId - 4) });
  const previous = yield* history;
  for (const [id] of previous.toReversed()) {
    if (id >= 41) {
      yield* sql`UPDATE effect_sql_migrations SET migration_id = ${id + 4} WHERE migration_id = ${id}`;
    }
  }
  for (const [offset, name] of [
    "MessageEmbeddings",
    "ThreadAsides",
    "ThreadParentAndDropAsides",
    "ThreadHandoff",
  ].entries()) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${41 + offset}, ${name})`;
  }
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > ${throughId}`;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades the shipped codeslop ledger without skipping upstream peer links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedCodeslopHistory(73);
      yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-01 00:00:00' WHERE migration_id = 59`;
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
        VALUES ('codeslop-thread', '2026-10-01', '2026-10-01', '2026-10-02', 42)`;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 70),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
        [{ created_at: "2026-10-01 00:00:00" }],
      );
      yield* sql`INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced)
        VALUES ('peer', 'secret', 'Peer', '[]', 'full-access', '2026-10-01', '2027-10-01', 1)`;
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([41, 44, 58, 59, 67])("upgrades codeslop through migration %s", (throughId) =>
    Effect.gen(function* () {
      yield* seedCodeslopHistory(throughId);
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unknown codeslop migrations without rewriting their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedCodeslopHistory(73);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (74, 'UnknownForkMigration')`;
      const before = yield* history;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "unexpected history at 74:UnknownForkMigration");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back codeslop consolidation if an upstream migration fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedCodeslopHistory(73);
      yield* sql`CREATE TABLE peer_environment_links (environment_id TEXT PRIMARY KEY, fenced INTEGER)`;
      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      yield* sql`DROP TABLE peer_environment_links`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps embeddings in a separate codeslop migration ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedCodeslopHistory(73);
      yield* sql`INSERT INTO message_embeddings
        (message_id, chunk_index, thread_id, model, message_updated_at, chunk_text, vector, updated_at)
        VALUES ('message', 0, 'thread', 'model', '2026-10-01', 'Keep this embedding', ${new Uint8Array([1, 2, 3])}, '2026-10-01')`;
      yield* sql`DROP TABLE codeslop_sql_migrations`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* sql`SELECT chunk_text, vector FROM message_embeddings`, [
        { chunk_text: "Keep this embedding", vector: new Uint8Array([1, 2, 3]) },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT migration_id, name FROM codeslop_sql_migrations`, [
        { migration_id: 1, name: "MessageEmbeddings" },
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
