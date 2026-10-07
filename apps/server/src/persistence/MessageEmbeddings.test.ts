import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "./Sqlite.ts";
import { MessageEmbeddingRepositoryLive } from "./MessageEmbeddings.ts";
import { MessageEmbeddingRepository } from "./Services/MessageEmbeddings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { packEmbedding } from "../semanticSearch/embeddingText.ts";

const MODEL = "test-model";

const repositoryLayer = it.layer(
  Layer.mergeAll(MessageEmbeddingRepositoryLive, ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
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

const thread = (
  id: string,
  second: number,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => {
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
      title: id,
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
      archivedAt: overrides.archivedAt ?? null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: overrides.deletedAt ?? null,
    },
  };
};

const message = (
  threadId: string,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  second: number,
  streaming = false,
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
    streaming,
    createdAt: at(second),
    updatedAt: at(second),
  },
});

const seedProjections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* sql`DELETE FROM message_embeddings`;
  yield* sql`DELETE FROM orchestration_v2_projection_messages`;
  yield* sql`DELETE FROM orchestration_v2_projection_threads`;
  yield* sql`DELETE FROM projection_projects`;

  yield* createProject;
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    thread("thread-active", 2),
    thread("thread-archived", 4, { archivedAt: at(6) }),
    thread("thread-deleted", 7, { deletedAt: at(9) }),
    message("thread-active", "msg-user", "user", "How do I rotate the API keys?", 10),
    message("thread-active", "msg-assistant", "assistant", "Rotate them in the settings page.", 11),
    message("thread-active", "msg-followup", "assistant", "Interim reasoning text.", 12),
    message("thread-active", "msg-streaming", "user", "still typing", 13, true),
    message("thread-active", "msg-system", "system", "system prompt", 14),
    message("thread-archived", "msg-archived", "user", "archived question", 15),
    message("thread-deleted", "msg-deleted", "user", "deleted question", 16),
  ];
  yield* Effect.forEach(events, projections.apply, { discard: true });
});

const vectorOf = (values: ReadonlyArray<number>) => packEmbedding(Float32Array.from(values));

repositoryLayer("MessageEmbeddingRepository", (it) => {
  it.effect("lists stale messages mirroring the lexical search population", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      const stale = yield* repository.listStaleMessages({ model: MODEL, limit: 50 });
      const staleIds = stale.map((message) => message.messageId).toSorted();
      // Every finished user/assistant message of active and archived threads;
      // streaming, system, and deleted threads excluded.
      assert.deepStrictEqual(staleIds, [
        "msg-archived",
        "msg-assistant",
        "msg-followup",
        "msg-user",
      ]);
    }),
  );

  it.effect("replaceForMessage clears staleness, including for empty chunk sets", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      yield* repository.replaceForMessage({
        messageId: MessageId.make("msg-user"),
        threadId: ThreadId.make("thread-active"),
        model: MODEL,
        messageUpdatedAt: "2026-05-01T00:00:10.000Z",
        updatedAt: "2026-05-01T00:01:00.000Z",
        chunks: [
          { chunkIndex: 0, chunkText: "How do I rotate the API keys?", vector: vectorOf([1, 0]) },
        ],
      });
      // No embeddable text: a sentinel row is written instead.
      yield* repository.replaceForMessage({
        messageId: MessageId.make("msg-assistant"),
        threadId: ThreadId.make("thread-active"),
        model: MODEL,
        messageUpdatedAt: "2026-05-01T00:00:11.000Z",
        updatedAt: "2026-05-01T00:01:00.000Z",
        chunks: [],
      });

      const stale = yield* repository.listStaleMessages({ model: MODEL, limit: 50 });
      assert.deepStrictEqual(
        stale.map((message) => message.messageId),
        [MessageId.make("msg-archived"), MessageId.make("msg-followup")],
      );

      // A message edit (updated_at change) makes it stale again.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET updated_at = '2026-05-01T00:02:00.000Z'
        WHERE message_id = 'msg-user'
      `;
      const staleAfterEdit = yield* repository.listStaleMessages({ model: MODEL, limit: 50 });
      assert.isTrue(
        staleAfterEdit.some((message) => message.messageId === MessageId.make("msg-user")),
      );

      // Sentinel rows are not returned as searchable vectors.
      const vectors = yield* repository.listVectors({ model: MODEL });
      assert.deepStrictEqual(
        vectors.map((vector) => vector.messageId),
        [MessageId.make("msg-user")],
      );
    }),
  );

  it.effect("listMatchMetadata joins active threads only", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      for (const [messageId, threadId, text] of [
        ["msg-user", "thread-active", "How do I rotate the API keys?"],
        ["msg-archived", "thread-archived", "archived question"],
        ["msg-deleted", "thread-deleted", "deleted question"],
      ] as const) {
        yield* repository.replaceForMessage({
          messageId: MessageId.make(messageId),
          threadId: ThreadId.make(threadId),
          model: MODEL,
          messageUpdatedAt: "2026-05-01T00:00:10.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          chunks: [{ chunkIndex: 0, chunkText: text, vector: vectorOf([1, 0]) }],
        });
      }

      const metadata = yield* repository.listMatchMetadata({
        model: MODEL,
        messageIds: [
          MessageId.make("msg-user"),
          MessageId.make("msg-archived"),
          MessageId.make("msg-deleted"),
        ],
      });
      assert.deepStrictEqual(
        metadata.map((row) => [row.messageId, row.source, row.chunkText]),
        [[MessageId.make("msg-user"), "user", "How do I rotate the API keys?"]],
      );
    }),
  );

  it.effect("deleteOrphaned removes rows for deleted threads and vanished messages", () =>
    Effect.gen(function* () {
      const repository = yield* MessageEmbeddingRepository;
      yield* seedProjections;

      for (const [messageId, threadId] of [
        ["msg-user", "thread-active"],
        ["msg-deleted", "thread-deleted"],
        ["msg-gone", "thread-active"],
      ] as const) {
        yield* repository.replaceForMessage({
          messageId: MessageId.make(messageId),
          threadId: ThreadId.make(threadId),
          model: MODEL,
          messageUpdatedAt: "2026-05-01T00:00:10.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          chunks: [{ chunkIndex: 0, chunkText: "text", vector: vectorOf([1, 0]) }],
        });
      }

      const removed = yield* repository.deleteOrphaned({ model: MODEL });
      assert.deepStrictEqual(removed.toSorted(), [
        MessageId.make("msg-deleted"),
        MessageId.make("msg-gone"),
      ]);

      const vectors = yield* repository.listVectors({ model: MODEL });
      assert.deepStrictEqual(
        vectors.map((vector) => vector.messageId),
        [MessageId.make("msg-user")],
      );
    }),
  );
});
