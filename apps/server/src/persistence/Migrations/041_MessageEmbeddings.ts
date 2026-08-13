import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Chunk-level embedding vectors for semantic thread search. Rows mirror
  // projection_thread_messages (message_updated_at marks staleness against the
  // source row); a sentinel chunk_index of -1 records messages with no
  // embeddable text so they are not re-scanned forever.
  yield* sql`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      model TEXT NOT NULL,
      message_updated_at TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, chunk_index, model)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_message_embeddings_thread
    ON message_embeddings(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_message_embeddings_model_message
    ON message_embeddings(model, message_id, message_updated_at)
  `;
});
