/**
 * HybridThreadSearch - Thread content search combining the lexical LIKE scan
 * with semantic embedding matches.
 *
 * Serves the existing `orchestration.searchThreads` RPC. Lexical results keep
 * exact-substring recall; semantic results surface threads whose wording
 * differs from the query. The two ranked lists are fused with reciprocal rank
 * fusion. Any semantic-path failure (model not yet downloaded, disabled,
 * repository error) degrades to lexical-only rather than failing the search.
 *
 * @module HybridThreadSearch
 */
import type {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationThreadSearchMatch,
  SemanticSearchStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { MessageEmbeddingRepository } from "../persistence/Services/MessageEmbeddings.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { EmbeddingModel } from "./EmbeddingModel.ts";
import { MessageEmbeddingIndex } from "./MessageEmbeddingIndex.ts";
import { buildSemanticSnippet } from "./embeddingText.ts";

const DEFAULT_LIMIT = 50;
/** Chunk candidates scanned before per-thread dedupe. */
const SEMANTIC_CANDIDATE_LIMIT = 48;
/**
 * Absolute cosine floor. MiniLM is a symmetric similarity model, so scores
 * scale with how closely the query's length matches the chunk's rather than
 * with relevance alone: a one-word query tops out far lower than a sentence.
 * This floor only has to exclude the noise band (unrelated chunks sit near 0);
 * the relative cutoff below does the discriminating.
 */
const MIN_SEMANTIC_SCORE = 0.2;
/**
 * Keep hits within this fraction of the query's best score, so each query is
 * judged against its own ceiling instead of one global number.
 */
const RELATIVE_SCORE_FLOOR_RATIO = 0.6;
/** Bound on semantic hits entering fusion, so weak tails cannot swamp lexical. */
const MAX_SEMANTIC_MATCHES = 12;
/** Reciprocal-rank-fusion constant (standard k=60). */
const RRF_K = 60;

export class HybridThreadSearch extends Context.Service<
  HybridThreadSearch,
  {
    readonly searchThreads: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;
    /** Feature status for the settings page; never fails. */
    readonly getStatus: Effect.Effect<SemanticSearchStatus>;
  }
>()("t3/semanticSearch/HybridThreadSearch") {}

export const make = Effect.fn("semanticSearch.hybridThreadSearch.make")(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const model = yield* EmbeddingModel;
  const index = yield* MessageEmbeddingIndex;
  const repository = yield* MessageEmbeddingRepository;

  const semanticMatches = (
    input: OrchestrationSearchThreadsInput,
  ): Effect.Effect<ReadonlyArray<OrchestrationThreadSearchMatch>> =>
    Effect.gen(function* () {
      if (!(yield* model.isEnabled)) {
        return [];
      }
      // While the model is still downloading/loading, embedTexts would queue
      // behind the load; stay lexical-only instead of stalling the search.
      if ((yield* model.runtimeState)._tag !== "ready") {
        return [];
      }
      yield* index.ensureLoaded(model.indexKey);
      if ((yield* index.size) === 0) {
        return [];
      }
      const queryVectors = yield* model.embedTexts([input.query]);
      const queryVector = queryVectors[0];
      if (queryVector === undefined) {
        return [];
      }
      const candidates = yield* index.search(queryVector, SEMANTIC_CANDIDATE_LIMIT);
      const bestScore = candidates[0]?.score ?? 0;
      if (bestScore < MIN_SEMANTIC_SCORE) {
        return [];
      }
      const scoreFloor = Math.max(MIN_SEMANTIC_SCORE, bestScore * RELATIVE_SCORE_FLOOR_RATIO);
      const hits = candidates.filter((hit) => hit.score >= scoreFloor);

      // Hits are score-sorted; keep the best chunk per thread.
      const bestPerThread = new Map<ThreadId, (typeof hits)[number]>();
      for (const hit of hits) {
        if (!bestPerThread.has(hit.threadId)) {
          bestPerThread.set(hit.threadId, hit);
        }
      }
      const winners = [...bestPerThread.values()].slice(0, MAX_SEMANTIC_MATCHES);
      const metadata = yield* repository.listMatchMetadata({
        model: model.indexKey,
        messageIds: [...new Set(winners.map((hit) => hit.messageId))],
      });
      const metadataByChunk = new Map(
        metadata.map((row) => [`${row.messageId}:${row.chunkIndex}`, row]),
      );

      const matches: OrchestrationThreadSearchMatch[] = [];
      for (const hit of winners) {
        // Missing metadata means the thread is deleted/archived or the row
        // changed underneath the index; drop the hit.
        const row = metadataByChunk.get(`${hit.messageId}:${hit.chunkIndex}`);
        if (row === undefined) {
          continue;
        }
        matches.push({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSemanticSnippet(row.chunkText),
          messageCreatedAt: row.messageCreatedAt,
          matchKind: "semantic",
        });
      }
      return matches;
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.logDebug("semanticSearch.query.skipped", { error }).pipe(
          Effect.as([] as ReadonlyArray<OrchestrationThreadSearchMatch>),
        ),
      ),
    );

  const searchThreads: HybridThreadSearch["Service"]["searchThreads"] = Effect.fn(
    "HybridThreadSearch.searchThreads",
  )(function* (input) {
    const [lexical, semantic] = yield* Effect.all(
      [snapshotQuery.searchThreads(input), semanticMatches(input)],
      { concurrency: 2 },
    );
    if (semantic.length === 0) {
      return lexical;
    }

    interface FusedEntry {
      score: number;
      lexical?: OrchestrationThreadSearchMatch;
      semantic?: OrchestrationThreadSearchMatch;
    }
    const fused = new Map<ThreadId, FusedEntry>();
    const contribute = (
      matches: ReadonlyArray<OrchestrationThreadSearchMatch>,
      kind: "lexical" | "semantic",
    ) => {
      matches.forEach((match, rank) => {
        const entry = fused.get(match.threadId) ?? { score: 0 };
        entry.score += 1 / (RRF_K + rank + 1);
        if (entry[kind] === undefined) {
          entry[kind] = match;
        }
        fused.set(match.threadId, entry);
      });
    };
    contribute(lexical.matches, "lexical");
    contribute(semantic, "semantic");

    const limit = input.limit ?? DEFAULT_LIMIT;
    const matches = [...fused.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) =>
        entry.lexical !== undefined
          ? { ...entry.lexical, matchKind: "lexical" as const }
          : entry.semantic!,
      );
    return { matches };
  });

  const getStatus: HybridThreadSearch["Service"]["getStatus"] = Effect.gen(function* () {
    const base = {
      modelId: model.modelId,
      indexedMessages: 0,
      pendingMessages: 0,
    };
    if (!(yield* model.isEnabled)) {
      return { ...base, state: "disabled" as const };
    }
    yield* index.ensureLoaded(model.indexKey).pipe(Effect.ignore);
    const counters = {
      ...base,
      indexedMessages: yield* index.size,
      pendingMessages: yield* repository
        .countStaleMessages({ model: model.indexKey })
        .pipe(Effect.orElseSucceed(() => 0)),
    };
    const runtime = yield* model.runtimeState;
    switch (runtime._tag) {
      case "ready":
        return { ...counters, state: "ready" as const };
      case "downloading":
        return {
          ...counters,
          state: "downloading" as const,
          downloadedBytes: runtime.downloadedBytes,
          totalBytes: runtime.totalBytes,
        };
      case "error":
        return { ...counters, state: "error" as const, errorMessage: runtime.reason };
      case "idle":
        // Kick the download immediately so the settings page shows progress
        // without waiting for the next indexer tick.
        yield* Effect.forkDetach(Effect.ignore(model.ensureReady));
        return { ...counters, state: "pending" as const };
    }
  });

  return HybridThreadSearch.of({ searchThreads, getStatus });
});

export const HybridThreadSearchLive = Layer.effect(HybridThreadSearch, make());

/** Lexical-only pass-through for tests that mock ProjectionSnapshotQuery. */
export const HybridThreadSearchLexicalOnly = Layer.effect(
  HybridThreadSearch,
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    return HybridThreadSearch.of({
      searchThreads: snapshotQuery.searchThreads,
      getStatus: Effect.succeed({
        state: "disabled",
        modelId: "",
        indexedMessages: 0,
        pendingMessages: 0,
      }),
    });
  }),
);
