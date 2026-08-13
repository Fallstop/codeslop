/**
 * MessageEmbeddingRepository - Persistence interface for semantic-search
 * embedding chunks.
 *
 * Rows are derived data keyed off projection_thread_messages: each embeddable
 * message is split into chunks and every chunk stores one vector. Staleness is
 * tracked by comparing the stored message_updated_at against the source row.
 *
 * @module MessageEmbeddingRepository
 */
import {
  IsoDateTime,
  MessageId,
  OrchestrationThreadSearchSource,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** Sentinel chunk index recording "message has no embeddable text". */
export const EMBEDDING_EMPTY_CHUNK_INDEX = -1;

export const MessageEmbeddingChunkWrite = Schema.Struct({
  chunkIndex: Schema.Int,
  chunkText: Schema.String,
  vector: Schema.Uint8Array,
});
export type MessageEmbeddingChunkWrite = typeof MessageEmbeddingChunkWrite.Type;

export const ReplaceMessageEmbeddingsInput = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  model: Schema.String,
  messageUpdatedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Empty means "nothing embeddable"; a sentinel row is written instead. */
  chunks: Schema.Array(MessageEmbeddingChunkWrite),
});
export type ReplaceMessageEmbeddingsInput = typeof ReplaceMessageEmbeddingsInput.Type;

export const ListStaleEmbeddingMessagesInput = Schema.Struct({
  model: Schema.String,
  limit: Schema.Int,
});
export type ListStaleEmbeddingMessagesInput = typeof ListStaleEmbeddingMessagesInput.Type;

export const StaleEmbeddingMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  text: Schema.String,
  updatedAt: IsoDateTime,
});
export type StaleEmbeddingMessage = typeof StaleEmbeddingMessage.Type;

export const ListEmbeddingVectorsInput = Schema.Struct({
  model: Schema.String,
});
export type ListEmbeddingVectorsInput = typeof ListEmbeddingVectorsInput.Type;

export const MessageEmbeddingVector = Schema.Struct({
  messageId: MessageId,
  chunkIndex: Schema.Int,
  threadId: ThreadId,
  vector: Schema.Uint8Array,
});
export type MessageEmbeddingVector = typeof MessageEmbeddingVector.Type;

export const ListEmbeddingMatchMetadataInput = Schema.Struct({
  model: Schema.String,
  messageIds: Schema.Array(MessageId),
});
export type ListEmbeddingMatchMetadataInput = typeof ListEmbeddingMatchMetadataInput.Type;

/**
 * Chunk text plus thread/project routing data for search hits, restricted to
 * active (non-deleted, non-archived) threads.
 */
export const MessageEmbeddingMatchMetadata = Schema.Struct({
  messageId: MessageId,
  chunkIndex: Schema.Int,
  chunkText: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  messageCreatedAt: IsoDateTime,
});
export type MessageEmbeddingMatchMetadata = typeof MessageEmbeddingMatchMetadata.Type;

export const DeleteOrphanedEmbeddingsInput = Schema.Struct({
  model: Schema.String,
});
export type DeleteOrphanedEmbeddingsInput = typeof DeleteOrphanedEmbeddingsInput.Type;

/**
 * MessageEmbeddingRepositoryShape - Service API for embedding persistence.
 */
export interface MessageEmbeddingRepositoryShape {
  /**
   * Replace all stored chunks for a message with the given set (transactional
   * delete + insert). Writes a sentinel row when `chunks` is empty so the
   * message is not treated as stale again.
   */
  readonly replaceForMessage: (
    input: ReplaceMessageEmbeddingsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List messages whose text has no up-to-date embedding for the model.
   *
   * Mirrors the lexical search population: settled user messages and
   * canonical assistant outputs of non-deleted threads (archived threads are
   * indexed too and filtered at query time).
   */
  readonly listStaleMessages: (
    input: ListStaleEmbeddingMessagesInput,
  ) => Effect.Effect<ReadonlyArray<StaleEmbeddingMessage>, ProjectionRepositoryError>;

  /**
   * Count messages still waiting for an up-to-date embedding (same
   * population as `listStaleMessages`). Drives the settings-page progress
   * readout.
   */
  readonly countStaleMessages: (
    input: Pick<ListStaleEmbeddingMessagesInput, "model">,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * List every stored vector for the model (sentinel rows excluded). Used to
   * hydrate the in-memory search index.
   */
  readonly listVectors: (
    input: ListEmbeddingVectorsInput,
  ) => Effect.Effect<ReadonlyArray<MessageEmbeddingVector>, ProjectionRepositoryError>;

  /**
   * Read chunk text and thread/project metadata for search hits, restricted
   * to active threads.
   */
  readonly listMatchMetadata: (
    input: ListEmbeddingMatchMetadataInput,
  ) => Effect.Effect<ReadonlyArray<MessageEmbeddingMatchMetadata>, ProjectionRepositoryError>;

  /**
   * Delete embeddings whose source message or thread no longer exists.
   * Returns the affected message ids so the in-memory index can drop them.
   */
  readonly deleteOrphaned: (
    input: DeleteOrphanedEmbeddingsInput,
  ) => Effect.Effect<ReadonlyArray<MessageId>, ProjectionRepositoryError>;
}

/**
 * MessageEmbeddingRepository - Service tag for embedding persistence.
 */
export class MessageEmbeddingRepository extends Context.Service<
  MessageEmbeddingRepository,
  MessageEmbeddingRepositoryShape
>()("t3/persistence/Services/MessageEmbeddings/MessageEmbeddingRepository") {}
