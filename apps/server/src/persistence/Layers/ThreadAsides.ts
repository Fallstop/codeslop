import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteThreadAsideInput,
  DeleteThreadAsidesByThreadInput,
  GetThreadAsideInput,
  ListThreadAsidesInput,
  ThreadAsideMessageRow,
  ThreadAsideRepository,
  type ThreadAsideRepositoryShape,
  ThreadAsideRow,
} from "../Services/ThreadAsides.ts";

// SQLite has no boolean; `synthetic` round-trips as 0/1.
const ThreadAsideMessageDbRowSchema = ThreadAsideMessageRow.mapFields(
  Struct.assign({ synthetic: Schema.Number }),
);

function toThreadAsideMessageRow(
  row: Schema.Schema.Type<typeof ThreadAsideMessageDbRowSchema>,
): ThreadAsideMessageRow {
  return {
    asideMessageId: row.asideMessageId,
    asideId: row.asideId,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    synthetic: row.synthetic === 1,
    createdAt: row.createdAt,
  };
}

const makeThreadAsideRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertAsideRow = SqlSchema.void({
    Request: ThreadAsideRow,
    execute: (row) => sql`
      INSERT INTO thread_asides (
        aside_id,
        thread_id,
        turn_id,
        title,
        fidelity,
        created_at,
        updated_at
      )
      VALUES (
        ${row.asideId},
        ${row.threadId},
        ${row.turnId},
        ${row.title},
        ${row.fidelity},
        ${row.createdAt},
        ${row.updatedAt}
      )
    `,
  });

  const getAsideRow = SqlSchema.findOneOption({
    Request: GetThreadAsideInput,
    Result: ThreadAsideRow,
    execute: ({ asideId }) => sql`
      SELECT
        aside_id AS "asideId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        title,
        fidelity,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_asides
      WHERE aside_id = ${asideId}
    `,
  });

  const listAsideRows = SqlSchema.findAll({
    Request: ListThreadAsidesInput,
    Result: ThreadAsideRow,
    execute: ({ threadId }) => sql`
      SELECT
        aside_id AS "asideId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        title,
        fidelity,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_asides
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, aside_id ASC
    `,
  });

  const listMessageRowsByThread = SqlSchema.findAll({
    Request: ListThreadAsidesInput,
    Result: ThreadAsideMessageDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        messages.aside_message_id AS "asideMessageId",
        messages.aside_id AS "asideId",
        messages.sequence,
        messages.role,
        messages.text,
        messages.synthetic,
        messages.created_at AS "createdAt"
      FROM thread_aside_messages AS messages
      INNER JOIN thread_asides AS asides
        ON asides.aside_id = messages.aside_id
      WHERE asides.thread_id = ${threadId}
      ORDER BY messages.aside_id ASC, messages.sequence ASC, messages.created_at ASC, messages.aside_message_id ASC
    `,
  });

  const listMessageRowsByAside = SqlSchema.findAll({
    Request: GetThreadAsideInput,
    Result: ThreadAsideMessageDbRowSchema,
    execute: ({ asideId }) => sql`
      SELECT
        aside_message_id AS "asideMessageId",
        aside_id AS "asideId",
        sequence,
        role,
        text,
        synthetic,
        created_at AS "createdAt"
      FROM thread_aside_messages
      WHERE aside_id = ${asideId}
      ORDER BY sequence ASC, created_at ASC, aside_message_id ASC
    `,
  });

  const insert: ThreadAsideRepositoryShape["insert"] = (input) =>
    insertAsideRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.insert:query")),
    );

  // One transaction so an aside never shows a question whose `updated_at`
  // ordering disagrees with it, and never an answer without its question.
  const appendMessage: ThreadAsideRepositoryShape["appendMessage"] = (input, touch) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO thread_aside_messages (
              aside_message_id,
              aside_id,
              sequence,
              role,
              text,
              synthetic,
              created_at
            )
            VALUES (
              ${input.asideMessageId},
              ${input.asideId},
              ${input.sequence},
              ${input.role},
              ${input.text},
              ${input.synthetic ? 1 : 0},
              ${input.createdAt}
            )
          `;
          yield* sql`
            UPDATE thread_asides
            SET updated_at = ${touch.updatedAt}
            WHERE aside_id = ${touch.asideId}
          `;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.appendMessage:query")),
      );

  const setFidelity: ThreadAsideRepositoryShape["setFidelity"] = (input) =>
    sql`
      UPDATE thread_asides
      SET fidelity = ${input.fidelity}
      WHERE aside_id = ${input.asideId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.setFidelity:query")),
    );

  const get: ThreadAsideRepositoryShape["get"] = (input) =>
    getAsideRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.get:query")),
    );

  const listByThreadId: ThreadAsideRepositoryShape["listByThreadId"] = (input) =>
    listAsideRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.listByThreadId:query")),
    );

  const listMessagesByThreadId: ThreadAsideRepositoryShape["listMessagesByThreadId"] = (input) =>
    listMessageRowsByThread(input).pipe(
      Effect.map((rows) => rows.map(toThreadAsideMessageRow)),
      Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.listMessagesByThreadId:query")),
    );

  const listMessagesByAsideId: ThreadAsideRepositoryShape["listMessagesByAsideId"] = (input) =>
    listMessageRowsByAside(input).pipe(
      Effect.map((rows) => rows.map(toThreadAsideMessageRow)),
      Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.listMessagesByAsideId:query")),
    );

  const deleteById: ThreadAsideRepositoryShape["deleteById"] = (input: DeleteThreadAsideInput) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM thread_aside_messages WHERE aside_id = ${input.asideId}`;
          yield* sql`DELETE FROM thread_asides WHERE aside_id = ${input.asideId}`;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.deleteById:query")),
      );

  const deleteByThreadId: ThreadAsideRepositoryShape["deleteByThreadId"] = (
    input: DeleteThreadAsidesByThreadInput,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM thread_aside_messages
            WHERE aside_id IN (
              SELECT aside_id FROM thread_asides WHERE thread_id = ${input.threadId}
            )
          `;
          yield* sql`DELETE FROM thread_asides WHERE thread_id = ${input.threadId}`;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ThreadAsideRepository.deleteByThreadId:query")),
      );

  return {
    insert,
    appendMessage,
    setFidelity,
    get,
    listByThreadId,
    listMessagesByThreadId,
    listMessagesByAsideId,
    deleteById,
    deleteByThreadId,
  } satisfies ThreadAsideRepositoryShape;
});

export const ThreadAsideRepositoryLive = Layer.effect(
  ThreadAsideRepository,
  makeThreadAsideRepository,
);
