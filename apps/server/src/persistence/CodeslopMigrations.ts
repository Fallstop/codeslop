import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import MessageEmbeddings from "./Migrations/Codeslop/001_MessageEmbeddings.ts";

const legacyNames = [
  "MessageEmbeddings",
  "ThreadAsides",
  "ThreadParentAndDropAsides",
  "ThreadHandoff",
] as const;

// Fork schema has its own ledger so upstream ids never need renumbering again.
export const runCodeslopMigrations = Migrator.make({})({
  table: "codeslop_sql_migrations",
  loader: Migrator.fromRecord({ "1_MessageEmbeddings": MessageEmbeddings }),
});

export const reconcileCodeslopMigrations = Effect.fn("reconcileCodeslopMigrations")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const history = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id >= 41`;
  if (!history.some((row) => legacyNames[row.migration_id - 41] === row.name)) return;

  const upstreamNames = new Map(manifest);
  for (const row of history) {
    const expected =
      row.migration_id < 45
        ? legacyNames[row.migration_id - 41]
        : upstreamNames.get(row.migration_id - 4);
    if (expected !== row.name) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Cannot consolidate codeslop migrations with unexpected history at ${row.migration_id}:${row.name}.`,
      });
    }
  }

  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 41`;
  const upstream = history
    .filter((row) => row.migration_id >= 45)
    .map((row) => ({ ...row, migration_id: row.migration_id - 4 }));
  if (upstream.length > 0) {
    yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(upstream)}`;
  }
});
