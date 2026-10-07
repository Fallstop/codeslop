import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadSearchMatch,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import { MessageEmbeddingRepositoryLive } from "../persistence/MessageEmbeddings.ts";
import { MessageEmbeddingRepository } from "../persistence/Services/MessageEmbeddings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import { EmbeddingModel, EmbeddingModelUnavailableError } from "./EmbeddingModel.ts";
import { HybridThreadSearch, HybridThreadSearchLive } from "./HybridThreadSearch.ts";
import { MessageEmbeddingIndexLive } from "./MessageEmbeddingIndex.ts";
import { packEmbedding } from "./embeddingText.ts";

const MODEL = "fake-model";

// Deterministic 3d "embeddings": the fake model maps known strings to fixed
// unit vectors so cosine scores are exact. The third axis carries a weak-but-
// best match, standing in for the low absolute scores short queries produce.
const FAKE_VECTORS = new Map<string, ReadonlyArray<number>>([
  ["credential rotation", [1, 0, 0]],
  ["Rotate them in the settings page.", [0.9, Math.sqrt(1 - 0.81), 0]],
  ["Completely unrelated cooking recipe.", [0, 1, 0]],
  ["shortcuts", [0, 0, 1]],
  ["Only a faint echo of the query topic.", [0, 0.96, 0.28]],
]);

const makeFakeModelLayer = (options?: { readonly enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;
  return Layer.succeed(
    EmbeddingModel,
    EmbeddingModel.of({
      modelId: MODEL,
      indexKey: MODEL,
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
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(
      Layer.mock(ThreadSearch.ThreadSearch)({
        search: () => Effect.succeed({ matches: options.lexicalMatches }),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const providerInstanceId = ProviderInstanceId.make("codex");
const PROJECT_ID = ProjectId.make("project-1");
const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 4, 1, 0, 0, second));

const createProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make("created:project-1"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    occurredAt: DateTime.formatIso(at(0)),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/tmp/project-1",
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at(0)),
      updatedAt: DateTime.formatIso(at(1)),
    },
  }),
);

const thread = (id: string, title: string, second: number): OrchestrationV2DomainEvent => {
  const threadId = ThreadId.make(id);
  return {
    id: EventId.make(`created:${id}`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: at(second),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: PROJECT_ID,
      title,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at(second),
      updatedAt: at(second + 1),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
};

const message = (
  threadId: string,
  id: string,
  role: "user" | "assistant",
  text: string,
  second: number,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId: ThreadId.make(threadId),
  providerInstanceId,
  occurredAt: at(second),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId: ThreadId.make(threadId),
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdAt: at(second),
    updatedAt: at(second),
  },
});

const seedSemanticCorpus = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const repository = yield* MessageEmbeddingRepository;

  yield* createProject;
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    thread("thread-semantic", "Untitled", 2),
    thread("thread-other", "Recipes", 4),
    thread("thread-faint", "Faint", 6),
    message(
      "thread-semantic",
      "msg-semantic",
      "assistant",
      "Rotate them in the settings page.",
      10,
    ),
    message("thread-other", "msg-other", "user", "Completely unrelated cooking recipe.", 11),
    message("thread-faint", "msg-faint", "user", "Only a faint echo of the query topic.", 12),
  ];
  yield* Effect.forEach(events, projections.apply, { discard: true });

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
    [
      "msg-faint",
      "thread-faint",
      "Only a faint echo of the query topic.",
      "2026-05-01T00:00:12.000Z",
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

it.effect("keeps a query's best match even when its absolute score is low", () =>
  Effect.gen(function* () {
    yield* seedSemanticCorpus;
    const search = yield* HybridThreadSearch;

    // Short queries score low against every chunk; the best of them is still
    // the answer, so the cutoff is relative to this query's own ceiling.
    const result = yield* search.searchThreads({ query: "shortcuts" });
    assert.deepStrictEqual(
      result.matches.map((match) => match.threadId),
      [ThreadId.make("thread-faint")],
    );
  }).pipe(Effect.provide(makeTestLayer({ lexicalMatches: [] }))),
);

it.effect("returns nothing semantic when the whole corpus is noise for the query", () =>
  Effect.gen(function* () {
    yield* seedSemanticCorpus;
    const search = yield* HybridThreadSearch;

    // "unknown" embeds to the zero vector, so every chunk scores 0.
    const result = yield* search.searchThreads({ query: "unknown" });
    assert.deepStrictEqual(result.matches, []);
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
      indexedMessages: 3,
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
