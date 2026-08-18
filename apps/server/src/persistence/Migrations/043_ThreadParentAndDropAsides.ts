import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Side chats are real threads rather than a parallel record type, so they
  // carry a link to the thread they were opened from. Null for ordinary
  // threads, which is every row that exists when this runs.
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN parent_thread_id TEXT
  `;

  // The shell snapshot ships child threads alongside their parents and the
  // client partitions them, so the hot read is "children of this thread".
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent
    ON projection_threads(parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;

  // Replaces migration 042's tables. That design answered side questions from a
  // tool-less one-shot channel; a side chat that can run commands needs a real
  // session, which a thread already is. Dropped rather than migrated: the
  // stored rows are question/answer text with no session behind them, so they
  // could not be resumed as chats.
  yield* sql`DROP TABLE IF EXISTS thread_aside_messages`;
  yield* sql`DROP TABLE IF EXISTS thread_asides`;
});
