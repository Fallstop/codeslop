/**
 * Semantic thread search contracts.
 *
 * Search itself rides on `orchestration.searchThreads`; these schemas cover
 * the feature's lifecycle surface — the settings page reads the embedding
 * model's download/index status through `semanticSearch.getStatus`.
 *
 * @module semanticSearch
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const SEMANTIC_SEARCH_WS_METHODS = {
  getStatus: "semanticSearch.getStatus",
} as const;

/**
 * - `disabled`: the setting is off (or force-disabled via env).
 * - `pending`: enabled; the model has not started loading yet.
 * - `downloading`: the model files are downloading / loading.
 * - `ready`: queries embed locally; indexing progress is in the counters.
 * - `error`: the last load attempt failed; retried automatically.
 */
export const SemanticSearchState = Schema.Literals([
  "disabled",
  "pending",
  "downloading",
  "ready",
  "error",
]);
export type SemanticSearchState = typeof SemanticSearchState.Type;

export const SemanticSearchStatus = Schema.Struct({
  state: SemanticSearchState,
  modelId: Schema.String,
  downloadedBytes: Schema.optionalKey(NonNegativeInt),
  totalBytes: Schema.optionalKey(NonNegativeInt),
  /** Messages with a current embedding in the index. */
  indexedMessages: NonNegativeInt,
  /** Messages still waiting to be embedded. */
  pendingMessages: NonNegativeInt,
  errorMessage: Schema.optionalKey(Schema.String),
});
export type SemanticSearchStatus = typeof SemanticSearchStatus.Type;

export const SemanticSearchGetStatusInput = Schema.Struct({});
export type SemanticSearchGetStatusInput = typeof SemanticSearchGetStatusInput.Type;
