import {
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { MessageEmbeddingRepositoryLive } from "../persistence/Layers/MessageEmbeddings.ts";
import { MessageEmbeddingRepository } from "../persistence/Services/MessageEmbeddings.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { EmbeddingModel, EmbeddingModelUnavailableError } from "./EmbeddingModel.ts";
import { HybridThreadSearch, HybridThreadSearchLive } from "./HybridThreadSearch.ts";
import { MessageEmbeddingIndexLive } from "./MessageEmbeddingIndex.ts";
import { packEmbedding } from "./embeddingText.ts";

const MODEL = "fake-model";

// Deterministic 2d "embeddings": the fake model maps known strings to fixed
// unit vectors so cosine scores are exact.
const FAKE_VECTORS = new Map<string, ReadonlyArray<number>>([
  ["credential rotation", [1, 0]],
  ["Rotate them in the settings page.", [0.9, Math.sqrt(1 - 0.81)]],
  ["Completely unrelated cooking recipe.", [0, 1]],
]);

const makeFakeModelLayer = (options?: { readonly enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;
  return Layer.succeed(
    EmbeddingModel,
    EmbeddingModel.of({
      modelId: MODEL,
      isEnabled: Effect.succeed(enabled),
      runtimeState: Effect.succeed(
        enabled ? { _tag: "ready" as const } : { _tag: "idle" as const },
      ),
      ensureReady: enabled
        ? Effect.void
        : Effect.fail(new EmbeddingModelUnavailableError({ reason: "disabled" })),
      embedTexts: (texts) =>
        enabled
          ? Effect.succeed(texts.map((text) => Float32Array.from(FAKE_VECTORS.get(text) ?? [0, 0])))
          : Effect.fail(new EmbeddingModelUnavailableError({ reason: "disabled" })),
    }),
  );
};

const makeTestLayer = (options: {
  readonly lexicalMatches: ReadonlyArray<OrchestrationThreadSearchMatch>;
  readonly modelEnabled?: boolean;
}) =>
  HybridThreadSearchLive.pipe(
    Layer.provideMerge(MessageEmbeddingIndexLive),
    Layer.provideMerge(makeFakeModelLayer({ enabled: options.modelEnabled ?? true })),
    Layer.provideMerge(MessageEmbeddingRepositoryLive),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        searchThreads: () => Effect.succeed({ matches: options.lexicalMatches }),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const seedSemanticCorpus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* MessageEmbeddingRepository;

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (
      'project-1', 'Project', '/tmp/project-1',
      '{"provider":"codex","model":"gpt-5-codex"}', '[]',
      '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:01.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, latest_turn_id,
      latest_user_message_at, pending_approval_count, pending_user_input_count,
      has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
    )
    VALUES
      (
        'thread-semantic', 'project-1', 'Untitled', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
        '2026-05-01T00:00:02.000Z', '2026-05-01T00:00:03.000Z', NULL, NULL
      ),
      (
        'thread-other', 'project-1', 'Recipes', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
        '2026-05-01T00:00:04.000Z', '2026-05-01T00:00:05.000Z', NULL, NULL
      )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    )
    VALUES
      ('msg-semantic', 'thread-semantic', NULL, 'assistant', 'Rotate them in the settings page.', 0,
        '2026-05-01T00:00:10.000Z', '2026-05-01T00:00:10.000Z'),
      ('msg-other', 'thread-other', NULL, 'user', 'Completely unrelated cooking recipe.', 0,
        '2026-05-01T00:00:11.000Z', '2026-05-01T00:00:11.000Z')
  `;

  for (const [messageId, threadId, text, messageUpdatedAt] of [
    [
      "msg-semantic",
      "thread-semantic",
      "Rotate them in the settings page.",
      "2026-05-01T00:00:10.000Z",
    ],
    [
      "msg-other",
      "thread-other",
      "Completely unrelated cooking recipe.",
      "2026-05-01T00:00:11.000Z",
    ],
  ] as const) {
    yield* repository.replaceForMessage({
      messageId: MessageId.make(messageId),
      threadId: ThreadId.make(threadId),
      model: MODEL,
      messageUpdatedAt,
      updatedAt: "2026-05-01T00:01:00.000Z",
      chunks: [
        {
          chunkIndex: 0,
          chunkText: text,
          vector: packEmbedding(Float32Array.from(FAKE_VECTORS.get(text)!)),
        },
      ],
    });
  }
});

it.effect("surfaces semantic matches when the query shares no words with the text", () =>
  Effect.gen(function* () {
    yield* seedSemanticCorpus;
    const search = yield* HybridThreadSearch;

    const result = yield* search.searchThreads({ query: "credential rotation" });
    assert.deepStrictEqual(
      result.matches.map((match) => [match.threadId, match.matchKind, match.snippet]),
      [[ThreadId.make("thread-semantic"), "semantic", "Rotate them in the settings page."]],
    );
    assert.equal(result.matches[0]?.source, "assistant");
    // The orthogonal "cooking recipe" vector stays below the score floor.
  }).pipe(Effect.provide(makeTestLayer({ lexicalMatches: [] }))),
);

it.effect("fuses lexical and semantic rankings, preferring the lexical snippet on overlap", () =>
  Effect.gen(function* () {
    yield* seedSemanticCorpus;
    const search = yield* HybridThreadSearch;

    const result = yield* search.searchThreads({ query: "credential rotation" });
    const byThread = new Map(result.matches.map((match) => [match.threadId, match]));

    // Thread in both lists ranks first and keeps its lexical representation.
    assert.equal(result.matches[0]?.threadId, ThreadId.make("thread-semantic"));
    assert.equal(result.matches[0]?.matchKind, "lexical");
    assert.equal(result.matches[0]?.snippet, "lexical snippet");
    // Lexical-only thread still present.
    assert.isTrue(byThread.has(ThreadId.make("thread-lexical")));
  }).pipe(
    Effect.provide(
      makeTestLayer({
        lexicalMatches: [
          {
            threadId: ThreadId.make("thread-lexical"),
            projectId: ProjectId.make("project-1"),
            source: "user",
            snippet: "another lexical match",
            messageCreatedAt: null,
          },
          {
            threadId: ThreadId.make("thread-semantic"),
            projectId: ProjectId.make("project-1"),
            source: "user",
            snippet: "lexical snippet",
            messageCreatedAt: null,
          },
        ],
      }),
    ),
  ),
);

it.effect("reports feature status for the settings page", () =>
  Effect.gen(function* () {
    yield* seedSemanticCorpus;
    const search = yield* HybridThreadSearch;

    const status = yield* search.getStatus;
    assert.deepStrictEqual(status, {
      state: "ready",
      modelId: MODEL,
      indexedMessages: 2,
      pendingMessages: 0,
    });
  }).pipe(Effect.provide(makeTestLayer({ lexicalMatches: [] }))),
);

it.effect("reports disabled status when the feature is off", () =>
  Effect.gen(function* () {
    const search = yield* HybridThreadSearch;
    const status = yield* search.getStatus;
    assert.equal(status.state, "disabled");
  }).pipe(Effect.provide(makeTestLayer({ lexicalMatches: [], modelEnabled: false }))),
);

it.effect("returns lexical results untouched when the model is unavailable", () =>
  Effect.gen(function* () {
    yield* seedSemanticCorpus;
    const search = yield* HybridThreadSearch;

    const lexicalMatch: OrchestrationThreadSearchMatch = {
      threadId: ThreadId.make("thread-lexical"),
      projectId: ProjectId.make("project-1"),
      source: "user",
      snippet: "lexical snippet",
      messageCreatedAt: null,
    };
    const result = yield* search.searchThreads({ query: "credential rotation" });
    assert.deepStrictEqual(result.matches, [lexicalMatch]);
  }).pipe(
    Effect.provide(
      makeTestLayer({
        modelEnabled: false,
        lexicalMatches: [
          {
            threadId: ThreadId.make("thread-lexical"),
            projectId: ProjectId.make("project-1"),
            source: "user",
            snippet: "lexical snippet",
            messageCreatedAt: null,
          },
        ],
      }),
    ),
  ),
);
