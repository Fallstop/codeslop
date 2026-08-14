import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Side conversations hanging off a thread. Not a projection: asides are
  // authored here rather than derived from the orchestration event log, so
  // these rows are the source of truth and are cleaned up with their thread.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_asides (
      aside_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      title TEXT NOT NULL,
      fidelity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_asides_thread
    ON thread_asides(thread_id, created_at)
  `;

  // Ordered by explicit sequence rather than created_at: two messages in one
  // exchange can land on the same ISO timestamp, and the read path must not
  // present an answer before its question.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_aside_messages (
      aside_message_id TEXT PRIMARY KEY,
      aside_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      synthetic INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_aside_messages_aside
    ON thread_aside_messages(aside_id, sequence)
  `;
});
