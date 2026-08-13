/**
 * MessageEmbeddingIndex - In-memory vector index over message embedding chunks.
 *
 * Vectors persist in the message_embeddings table; this service keeps them
 * resident so a search is a brute-force cosine scan (fine at chat scale)
 * instead of a per-query blob read of the whole table. Hydrated lazily from
 * SQLite on first demand, then kept in sync by the indexer's writes.
 *
 * @module MessageEmbeddingIndex
 */
import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { MessageEmbeddingRepository } from "../persistence/Services/MessageEmbeddings.ts";
import { dotProduct, unpackEmbedding } from "./embeddingText.ts";

export interface IndexedMessageChunk {
  readonly chunkIndex: number;
  readonly vector: Float32Array;
}

export interface EmbeddingSearchHit {
  readonly messageId: MessageId;
  readonly chunkIndex: number;
  readonly threadId: ThreadId;
  readonly score: number;
}

interface MessageEntry {
  readonly threadId: ThreadId;
  readonly chunks: ReadonlyArray<IndexedMessageChunk>;
}

export class MessageEmbeddingIndex extends Context.Service<
  MessageEmbeddingIndex,
  {
    /** Hydrate from SQLite once; later calls are no-ops after a success. */
    readonly ensureLoaded: (model: string) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly setMessageChunks: (
      messageId: MessageId,
      threadId: ThreadId,
      chunks: ReadonlyArray<IndexedMessageChunk>,
    ) => Effect.Effect<void>;
    readonly removeMessages: (messageIds: ReadonlyArray<MessageId>) => Effect.Effect<void>;
    /** Best-scoring chunk per message, sorted by descending cosine score. */
    readonly search: (
      query: Float32Array,
      topK: number,
    ) => Effect.Effect<ReadonlyArray<EmbeddingSearchHit>>;
    readonly size: Effect.Effect<number>;
  }
>()("t3/semanticSearch/MessageEmbeddingIndex") {}

export const make = Effect.fn("semanticSearch.messageEmbeddingIndex.make")(function* () {
  const repository = yield* MessageEmbeddingRepository;
  const entries = new Map<MessageId, MessageEntry>();
  const loadMutex = yield* Semaphore.make(1);
  let loaded = false;

  const ensureLoaded: MessageEmbeddingIndex["Service"]["ensureLoaded"] = (model) =>
    loadMutex.withPermits(1)(
      Effect.gen(function* () {
        if (loaded) {
          return;
        }
        const vectors = yield* repository.listVectors({ model });
        const byMessage = new Map<
          MessageId,
          { threadId: ThreadId; chunks: IndexedMessageChunk[] }
        >();
        for (const row of vectors) {
          const vector = unpackEmbedding(row.vector);
          if (vector === null) {
            continue;
          }
          const entry = byMessage.get(row.messageId) ?? { threadId: row.threadId, chunks: [] };
          entry.chunks.push({ chunkIndex: row.chunkIndex, vector });
          byMessage.set(row.messageId, entry);
        }
        // Writes that landed via setMessageChunks while loading win over the
        // snapshot read; only fill messages the index has not seen yet.
        for (const [messageId, entry] of byMessage) {
          if (!entries.has(messageId)) {
            entries.set(messageId, entry);
          }
        }
        loaded = true;
      }),
    );

  const setMessageChunks: MessageEmbeddingIndex["Service"]["setMessageChunks"] = (
    messageId,
    threadId,
    chunks,
  ) =>
    Effect.sync(() => {
      if (chunks.length === 0) {
        entries.set(messageId, { threadId, chunks: [] });
        return;
      }
      entries.set(messageId, { threadId, chunks });
    });

  const removeMessages: MessageEmbeddingIndex["Service"]["removeMessages"] = (messageIds) =>
    Effect.sync(() => {
      for (const messageId of messageIds) {
        entries.delete(messageId);
      }
    });

  const search: MessageEmbeddingIndex["Service"]["search"] = (query, topK) =>
    Effect.sync(() => {
      const hits: EmbeddingSearchHit[] = [];
      for (const [messageId, entry] of entries) {
        let bestScore = -Infinity;
        let bestChunkIndex = -1;
        for (const chunk of entry.chunks) {
          const score = dotProduct(query, chunk.vector);
          if (score > bestScore) {
            bestScore = score;
            bestChunkIndex = chunk.chunkIndex;
          }
        }
        if (bestChunkIndex >= 0) {
          hits.push({
            messageId,
            chunkIndex: bestChunkIndex,
            threadId: entry.threadId,
            score: bestScore,
          });
        }
      }
      hits.sort((left, right) => right.score - left.score);
      return hits.slice(0, topK);
    });

  const size = Effect.sync(() => entries.size);

  return MessageEmbeddingIndex.of({ ensureLoaded, setMessageChunks, removeMessages, search, size });
});

export const MessageEmbeddingIndexLive = Layer.effect(MessageEmbeddingIndex, make());
