/**
 * Semantic search lifecycle contracts. Search itself rides on `orchestration.searchThreads`;
 * the settings page reads model download and index status through `semanticSearch.getStatus`.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const SEMANTIC_SEARCH_WS_METHODS = {
  getStatus: "semanticSearch.getStatus",
} as const;

/**
 * `disabled`: setting off. `pending`: enabled, not loading yet. `downloading`: fetching or
 * loading the model. `ready`: queries embed locally. `error`: last load failed; retried.
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
