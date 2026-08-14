/**
 * MessageEmbeddingIndexer - Background loop that keeps message embeddings
 * current.
 *
 * Opportunistic work: each tick runs only while a foreground client is active
 * (BackgroundPolicy), drains a bounded number of stale-message batches, and
 * never fails the loop — embedding problems degrade semantic search rather
 * than crash the server. Orphaned rows (deleted threads/messages) are swept
 * periodically.
 *
 * @module MessageEmbeddingIndexer
 */
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import {
  MessageEmbeddingRepository,
  type StaleEmbeddingMessage,
} from "../persistence/Services/MessageEmbeddings.ts";
import { forkParked } from "../serverActivation.ts";
import { EmbeddingModel } from "./EmbeddingModel.ts";
import { MessageEmbeddingIndex } from "./MessageEmbeddingIndex.ts";
import { chunkTextForEmbedding, packEmbedding, unpackEmbedding } from "./embeddingText.ts";

const TICK_INTERVAL_MS = 15_000;
const MESSAGE_BATCH_SIZE = 8;
const MAX_BATCHES_PER_TICK = 40;
const INTER_BATCH_PAUSE_MS = 200;
/** Sweep orphaned rows roughly every 10 minutes of active ticks. */
const CLEANUP_EVERY_TICKS = 40;

const startIndexer = Effect.gen(function* () {
  const model = yield* EmbeddingModel;
  const backgroundPolicy = yield* BackgroundPolicy;
  const repository = yield* MessageEmbeddingRepository;
  const index = yield* MessageEmbeddingIndex;

  let tickCount = 0;

  const processBatch = (messages: ReadonlyArray<StaleEmbeddingMessage>) =>
    Effect.gen(function* () {
      const chunked = messages.map((message) => ({
        message,
        chunks: chunkTextForEmbedding(message.text),
      }));
      const texts = chunked.flatMap((entry) => entry.chunks);
      const vectors = yield* model.embedTexts(texts);
      const now = DateTime.formatIso(yield* DateTime.now);

      let vectorOffset = 0;
      for (const { message, chunks } of chunked) {
        const chunkWrites = chunks.map((chunkText, chunkIndex) => ({
          chunkIndex,
          chunkText,
          vector: packEmbedding(vectors[vectorOffset + chunkIndex]!),
        }));
        vectorOffset += chunks.length;
        yield* repository.replaceForMessage({
          messageId: message.messageId,
          threadId: message.threadId,
          model: model.indexKey,
          messageUpdatedAt: message.updatedAt,
          updatedAt: now,
          chunks: chunkWrites,
        });
        yield* index.setMessageChunks(
          message.messageId,
          message.threadId,
          chunkWrites.map((write) => ({
            chunkIndex: write.chunkIndex,
            vector: unpackEmbedding(write.vector)!,
          })),
        );
      }
    });

  const tick = Effect.gen(function* () {
    // The setting can flip at runtime; every tick re-checks it.
    if (!(yield* model.isEnabled)) {
      return;
    }
    if (!(yield* backgroundPolicy.shouldRunOpportunisticWork)) {
      return;
    }
    // Load (download on first enable) even when there is nothing to index,
    // so the settings-page status reaches "ready" on empty histories too.
    yield* model.ensureReady;
    yield* index.ensureLoaded(model.indexKey);

    tickCount += 1;
    if (tickCount === 1) {
      // Vectors from a superseded chunking scheme are dead weight once this
      // key's re-index starts; drop them on the first working tick.
      yield* repository.deleteOtherModels({ model: model.indexKey });
    }
    if (tickCount % CLEANUP_EVERY_TICKS === 1) {
      const removed = yield* repository.deleteOrphaned({ model: model.indexKey });
      if (removed.length > 0) {
        yield* index.removeMessages(removed);
        yield* Effect.logDebug("semanticSearch.indexer.cleanup", { removed: removed.length });
      }
    }

    let batches = 0;
    let indexed = 0;
    while (batches < MAX_BATCHES_PER_TICK) {
      if (batches > 0 && !(yield* backgroundPolicy.shouldRunOpportunisticWork)) {
        break;
      }
      const stale = yield* repository.listStaleMessages({
        model: model.indexKey,
        limit: MESSAGE_BATCH_SIZE,
      });
      if (stale.length === 0) {
        break;
      }
      yield* processBatch(stale);
      indexed += stale.length;
      batches += 1;
      yield* Effect.sleep(Duration.millis(INTER_BATCH_PAUSE_MS));
    }
    if (indexed > 0) {
      yield* Effect.logDebug("semanticSearch.indexer.tick-complete", { indexed });
    }
  });

  yield* forkParked(
    tick.pipe(
      // Model-unavailable is expected (first download pending, offline); the
      // model service already logged and set its retry backoff.
      Effect.catchTag("EmbeddingModelUnavailableError", () => Effect.void),
      Effect.catch((error: unknown) =>
        Effect.logWarning("semanticSearch.indexer.tick-failed", { error }),
      ),
      Effect.catchDefect((defect: unknown) =>
        Effect.logWarning("semanticSearch.indexer.tick-defect", { defect }),
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(TICK_INTERVAL_MS))),
    ),
  );

  yield* Effect.logInfo("semanticSearch.indexer.started", { modelId: model.modelId });
});

export const MessageEmbeddingIndexerLive = Layer.effectDiscard(startIndexer);
