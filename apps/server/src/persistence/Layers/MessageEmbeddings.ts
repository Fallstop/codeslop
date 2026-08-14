import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteOrphanedEmbeddingsInput,
  EMBEDDING_EMPTY_CHUNK_INDEX,
  ListEmbeddingMatchMetadataInput,
  ListEmbeddingVectorsInput,
  ListStaleEmbeddingMessagesInput,
  MessageEmbeddingMatchMetadata,
  MessageEmbeddingRepository,
  type MessageEmbeddingRepositoryShape,
  MessageEmbeddingVector,
  type ReplaceMessageEmbeddingsInput,
  StaleEmbeddingMessage,
} from "../Services/MessageEmbeddings.ts";
import { MessageId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DeletedEmbeddingRowSchema = Schema.Struct({
  messageId: MessageId,
});

const StaleMessageCountRowSchema = Schema.Struct({
  staleCount: Schema.Number,
});

const makeMessageEmbeddingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Shared predicate for "messages that should have an embedding but don't":
  // settled user messages and canonical assistant outputs of non-deleted
  // threads, without an up-to-date row for this model.
  const staleMessagesFilter = (model: string) => sql`
    projection_threads.deleted_at IS NULL
    AND messages.is_streaming = 0
    AND (
      messages.role = 'user'
      OR (
        messages.role = 'assistant'
        AND messages.message_id IN (
          SELECT turns.assistant_message_id
          FROM projection_turns AS turns
          WHERE turns.assistant_message_id IS NOT NULL
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM message_embeddings AS embeddings
      WHERE embeddings.message_id = messages.message_id
        AND embeddings.model = ${model}
        AND embeddings.message_updated_at = messages.updated_at
    )
  `;

  const listStaleMessageRows = SqlSchema.findAll({
    Request: ListStaleEmbeddingMessagesInput,
    Result: StaleEmbeddingMessage,
    execute: ({ model, limit }) =>
      sql`
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.text,
          messages.updated_at AS "updatedAt"
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads
          ON projection_threads.thread_id = messages.thread_id
        WHERE ${staleMessagesFilter(model)}
        ORDER BY messages.created_at DESC
        LIMIT ${limit}
      `,
  });

  const countStaleMessageRows = SqlSchema.findOne({
    Request: Schema.Struct({ model: Schema.String }),
    Result: StaleMessageCountRowSchema,
    execute: ({ model }) =>
      sql`
        SELECT COUNT(*) AS "staleCount"
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads
          ON projection_threads.thread_id = messages.thread_id
        WHERE ${staleMessagesFilter(model)}
      `,
  });

  const listVectorRows = SqlSchema.findAll({
    Request: ListEmbeddingVectorsInput,
    Result: MessageEmbeddingVector,
    execute: ({ model }) =>
      sql`
        SELECT
          message_id AS "messageId",
          chunk_index AS "chunkIndex",
          thread_id AS "threadId",
          vector
        FROM message_embeddings
        WHERE model = ${model}
          AND chunk_index >= 0
      `,
  });

  const listMatchMetadataRows = SqlSchema.findAll({
    Request: ListEmbeddingMatchMetadataInput,
    Result: MessageEmbeddingMatchMetadata,
    execute: ({ model, messageIds }) =>
      sql`
        SELECT
          embeddings.message_id AS "messageId",
          embeddings.chunk_index AS "chunkIndex",
          embeddings.chunk_text AS "chunkText",
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          CASE messages.role
            WHEN 'user' THEN 'user'
            ELSE 'assistant'
          END AS source,
          messages.created_at AS "messageCreatedAt"
        FROM message_embeddings AS embeddings
        INNER JOIN projection_thread_messages AS messages
          ON messages.message_id = embeddings.message_id
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE embeddings.model = ${model}
          AND embeddings.chunk_index >= 0
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND embeddings.message_id IN (
            SELECT value FROM json_each(${JSON.stringify(messageIds)})
          )
      `,
  });

  const deleteOrphanedRows = SqlSchema.findAll({
    Request: DeleteOrphanedEmbeddingsInput,
    Result: DeletedEmbeddingRowSchema,
    execute: ({ model }) =>
      sql`
        DELETE FROM message_embeddings
        WHERE model = ${model}
          AND (
            message_id NOT IN (
              SELECT message_id FROM projection_thread_messages
            )
            OR thread_id IN (
              SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL
            )
          )
        RETURNING message_id AS "messageId"
      `,
  });

  const deleteOtherModels: MessageEmbeddingRepositoryShape["deleteOtherModels"] = ({ model }) =>
    sql`DELETE FROM message_embeddings WHERE model != ${model}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("MessageEmbeddingRepository.deleteOtherModels:query")),
    );

  const replaceForMessage: MessageEmbeddingRepositoryShape["replaceForMessage"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM message_embeddings
            WHERE message_id = ${input.messageId} AND model = ${input.model}
          `;
          const rows: ReadonlyArray<ReplaceMessageEmbeddingsInput["chunks"][number]> =
            input.chunks.length > 0
              ? input.chunks
              : [
                  {
                    chunkIndex: EMBEDDING_EMPTY_CHUNK_INDEX,
                    chunkText: "",
                    vector: new Uint8Array(0),
                  },
                ];
          yield* Effect.forEach(
            rows,
            (chunk) => sql`
              INSERT INTO message_embeddings (
                message_id,
                chunk_index,
                thread_id,
                model,
                message_updated_at,
                chunk_text,
                vector,
                updated_at
              )
              VALUES (
                ${input.messageId},
                ${chunk.chunkIndex},
                ${input.threadId},
                ${input.model},
                ${input.messageUpdatedAt},
                ${chunk.chunkText},
                ${chunk.vector},
                ${input.updatedAt}
              )
            `,
            { discard: true },
          );
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("MessageEmbeddingRepository.replaceForMessage:query"),
        ),
      );

  const listStaleMessages: MessageEmbeddingRepositoryShape["listStaleMessages"] = (input) =>
    listStaleMessageRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MessageEmbeddingRepository.listStaleMessages:query")),
    );

  const countStaleMessages: MessageEmbeddingRepositoryShape["countStaleMessages"] = (input) =>
    countStaleMessageRows(input).pipe(
      Effect.map((row) => row.staleCount),
      Effect.mapError(toPersistenceSqlError("MessageEmbeddingRepository.countStaleMessages:query")),
    );

  const listVectors: MessageEmbeddingRepositoryShape["listVectors"] = (input) =>
    listVectorRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MessageEmbeddingRepository.listVectors:query")),
    );

  const listMatchMetadata: MessageEmbeddingRepositoryShape["listMatchMetadata"] = (input) =>
    listMatchMetadataRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MessageEmbeddingRepository.listMatchMetadata:query")),
    );

  const deleteOrphaned: MessageEmbeddingRepositoryShape["deleteOrphaned"] = (input) =>
    deleteOrphanedRows(input).pipe(
      Effect.map((rows) => [...new Set(rows.map((row) => row.messageId))]),
      Effect.mapError(toPersistenceSqlError("MessageEmbeddingRepository.deleteOrphaned:query")),
    );

  return {
    replaceForMessage,
    listStaleMessages,
    countStaleMessages,
    listVectors,
    listMatchMetadata,
    deleteOrphaned,
    deleteOtherModels,
  } satisfies MessageEmbeddingRepositoryShape;
});

export const MessageEmbeddingRepositoryLive = Layer.effect(
  MessageEmbeddingRepository,
  makeMessageEmbeddingRepository,
);
