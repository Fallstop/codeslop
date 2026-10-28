// @effect-diagnostics nodeBuiltinImport:off - a standalone script that prints SQL.
// Prints a psql script applying pending migrations to a self-hosted relay database:
//   node scripts/self-hosted-migrations.ts | psql -v ON_ERROR_STOP=1 <database-url>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const dir = NodePath.join(import.meta.dirname, "../migrations/postgres");
const names = NodeFS.readdirSync(dir)
  .filter((name) => NodeFS.existsSync(NodePath.join(dir, name, "migration.sql")))
  .toSorted();

const lines = ["CREATE TABLE IF NOT EXISTS relay_self_hosted_migrations (name text PRIMARY KEY);"];
for (const name of names) {
  const sql = NodeFS.readFileSync(NodePath.join(dir, name, "migration.sql"), "utf8").replaceAll(
    "--> statement-breakpoint",
    ";",
  );
  lines.push(
    `SELECT NOT EXISTS (SELECT 1 FROM relay_self_hosted_migrations WHERE name = '${name}') AS pending \\gset`,
    "\\if :pending",
    `\\echo applying ${name}`,
    "BEGIN;",
    sql,
    `;INSERT INTO relay_self_hosted_migrations (name) VALUES ('${name}');`,
    "COMMIT;",
    "\\endif",
  );
}
process.stdout.write(`${lines.join("\n")}\n`);
