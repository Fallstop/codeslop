import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A handed-off thread keeps its history here but stops running: the link
  // names the environment that took over. Null for every row that exists when
  // this runs, and for every thread that never leaves this machine.
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN handed_off_to_json TEXT
  `;

  // The mirror on the receiving side: where an adopted thread came from.
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN continued_from_json TEXT
  `;

  // Set while a handoff is in flight. Its presence is half the split-brain
  // guard: the decider refuses thread.turn.start while this or
  // handed_off_to_json is set, so neither side runs the thread mid-move.
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN handoff_pending_json TEXT
  `;
});
