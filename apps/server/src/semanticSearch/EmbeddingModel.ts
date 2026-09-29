/**
 * EmbeddingModel - Local sentence-embedding runtime for semantic thread search.
 *
 * Wraps a lazily-loaded `@huggingface/transformers` feature-extraction
 * pipeline. The feature is opt-in via the `semanticSearchEnabled` server
 * setting; enabling it downloads the model once into `<stateDir>/models`
 * (~25MB) after which everything runs fully locally — no message text ever
 * leaves the machine. Download progress is tracked for the settings-page
 * status readout. Load failures (offline first run, unsupported runtime) mark
 * the model unavailable and are retried with a backoff, so semantic search
 * degrades to lexical-only instead of failing the server.
 *
 * @module EmbeddingModel
 */
import * as NodeModule from "node:module";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { EMBEDDING_SCHEME_VERSION } from "./embeddingText.ts";

export const DEFAULT_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

const requireFromHere = NodeModule.createRequire(import.meta.url);
type TransformersModule = typeof import("@huggingface/transformers");
const loadTransformers = (): TransformersModule =>
  requireFromHere("@huggingface/transformers") as TransformersModule;

const LOAD_RETRY_BACKOFF_MS = 15 * 60 * 1000;
const LOAD_TIMEOUT = "5 minutes";

export class EmbeddingModelUnavailableError extends Schema.TaggedError<EmbeddingModelUnavailableError>()(
  "EmbeddingModelUnavailableError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Embedding model unavailable: ${this.reason}`;
  }
}

export type EmbeddingModelError = EmbeddingModelUnavailableError;

export type EmbeddingModelRuntimeState =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "downloading";
      readonly downloadedBytes: number;
      readonly totalBytes: number;
    }
  | { readonly _tag: "ready" }
  | { readonly _tag: "error"; readonly reason: string };

interface FeatureExtractionPipeline {
  (
    texts: ReadonlyArray<string>,
    options: { pooling: "mean"; normalize: boolean },
  ): Promise<{
    readonly data: Float32Array;
    readonly dims: ReadonlyArray<number>;
  }>;
}

export class EmbeddingModel extends Context.Service<
  EmbeddingModel,
  {
    readonly modelId: string;
    /**
     * Storage key for persisted vectors: the model id plus the chunking scheme
     * version, so a chunking change invalidates rows instead of mixing
     * incompatible vectors into one index.
     */
    readonly indexKey: string;
    /** Follows the `semanticSearchEnabled` setting; T3_SEMANTIC_SEARCH=0 forces off. */
    readonly isEnabled: Effect.Effect<boolean>;
    /** Download/load lifecycle for the settings-page status readout. */
    readonly runtimeState: Effect.Effect<EmbeddingModelRuntimeState>;
    /** Load (downloading if needed) without embedding anything. */
    readonly ensureReady: Effect.Effect<void, EmbeddingModelError>;
    /**
     * Embed texts into normalized vectors (one per input, input order).
     * Loads the model on first use.
     */
    readonly embedTexts: (
      texts: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Float32Array>, EmbeddingModelError>;
  }
>()("t3/semanticSearch/EmbeddingModel") {}

const isDisabledByEnv = () => {
  const value = process.env["T3_SEMANTIC_SEARCH"];
  return value === "0" || value === "false";
};

type LoadState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loaded"; readonly pipeline: FeatureExtractionPipeline }
  | { readonly _tag: "failed"; readonly retryAtMs: number; readonly reason: string };

interface TransformersProgressEvent {
  readonly status: string;
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
}

export const make = Effect.fn("semanticSearch.embeddingModel.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const path = yield* Path.Path;
  const modelId = DEFAULT_EMBEDDING_MODEL_ID;
  const indexKey = `${modelId}@v${EMBEDDING_SCHEME_VERSION}`;
  const cacheDir = path.join(config.stateDir, "models");

  const loadState = yield* Ref.make<LoadState>({ _tag: "idle" });
  const loadMutex = yield* Semaphore.make(1);
  // Mutated synchronously by the transformers progress callback during load.
  let loadInFlight = false;
  const fileProgress = new Map<string, { loaded: number; total: number }>();

  const isEnabled: EmbeddingModel["Service"]["isEnabled"] = isDisabledByEnv()
    ? Effect.succeed(false)
    : serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.semanticSearchEnabled),
        Effect.orElseSucceed(() => false),
      );

  const loadPipeline = Effect.tryPromise({
    try: async () => {
      // `require`, not `import`: the package is a runtime external, and a
      // static or bundler-visible dynamic import would put its own imports of
      // sharp and onnxruntime-common in the emitted module graph. The single
      // executable can only `import` built-ins, so those would pass the
      // bundler and then throw inside the binary. Its CJS entry point loads
      // from the node_modules tree staged beside the executable.
      const transformers = loadTransformers();
      transformers.env.cacheDir = cacheDir;
      const pipeline = await transformers.pipeline("feature-extraction", modelId, {
        dtype: "q8",
        progress_callback: (event: TransformersProgressEvent) => {
          if (event.status === "progress" && event.file !== undefined) {
            fileProgress.set(event.file, {
              loaded: event.loaded ?? 0,
              total: event.total ?? 0,
            });
          }
        },
      });
      return pipeline as unknown as FeatureExtractionPipeline;
    },
    catch: (cause) =>
      new EmbeddingModelUnavailableError({
        reason: "Failed to load embedding model runtime",
        cause,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOAD_TIMEOUT,
      orElse: () =>
        new EmbeddingModelUnavailableError({ reason: "Embedding model load timed out" }),
    }),
  );

  const getPipeline = loadMutex.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* Ref.get(loadState);
      if (state._tag === "loaded") {
        return state.pipeline;
      }
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (state._tag === "failed" && nowMs < state.retryAtMs) {
        return yield* new EmbeddingModelUnavailableError({ reason: state.reason });
      }
      loadInFlight = true;
      return yield* loadPipeline.pipe(
        Effect.tap((pipeline) => Ref.set(loadState, { _tag: "loaded", pipeline })),
        Effect.tapCause((cause) =>
          Ref.set(loadState, {
            _tag: "failed",
            retryAtMs: nowMs + LOAD_RETRY_BACKOFF_MS,
            reason: "Embedding model failed to load; semantic search is lexical-only for now",
          }).pipe(
            Effect.andThen(
              Effect.logWarning("Embedding model load failed").pipe(
                Effect.annotateLogs({ modelId, cause: String(cause) }),
              ),
            ),
          ),
        ),
        Effect.onExit(() =>
          Effect.sync(() => {
            loadInFlight = false;
          }),
        ),
      );
    }),
  );

  const runtimeState: EmbeddingModel["Service"]["runtimeState"] = Effect.gen(function* () {
    const state = yield* Ref.get(loadState);
    if (state._tag === "loaded") {
      return { _tag: "ready" } as const;
    }
    if (loadInFlight) {
      let downloadedBytes = 0;
      let totalBytes = 0;
      for (const progress of fileProgress.values()) {
        downloadedBytes += progress.loaded;
        totalBytes += progress.total;
      }
      return { _tag: "downloading", downloadedBytes, totalBytes } as const;
    }
    if (state._tag === "failed") {
      return { _tag: "error", reason: state.reason } as const;
    }
    return { _tag: "idle" } as const;
  });

  const ensureReady: EmbeddingModel["Service"]["ensureReady"] = Effect.asVoid(getPipeline);

  const embedTexts: EmbeddingModel["Service"]["embedTexts"] = (texts) =>
    Effect.gen(function* () {
      if (!(yield* isEnabled)) {
        return yield* new EmbeddingModelUnavailableError({ reason: "Semantic search is disabled" });
      }
      if (texts.length === 0) {
        return [];
      }
      const pipeline = yield* getPipeline;
      const output = yield* Effect.tryPromise({
        try: () => pipeline(texts, { pooling: "mean", normalize: true }),
        catch: (cause) =>
          new EmbeddingModelUnavailableError({ reason: "Embedding inference failed", cause }),
      });
      const [rows, dims] = [output.dims[0] ?? 0, output.dims[1] ?? 0];
      if (rows !== texts.length || dims === 0) {
        return yield* new EmbeddingModelUnavailableError({
          reason: `Unexpected embedding output shape ${output.dims.join("x")}`,
        });
      }
      const vectors: Float32Array[] = [];
      for (let row = 0; row < rows; row += 1) {
        vectors.push(output.data.slice(row * dims, (row + 1) * dims));
      }
      return vectors;
    });

  return EmbeddingModel.of({
    modelId,
    indexKey,
    isEnabled,
    runtimeState,
    ensureReady,
    embedTexts,
  });
});

export const layer = Layer.effect(EmbeddingModel, make());
