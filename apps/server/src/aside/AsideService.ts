/**
 * AsideService — thread asides: side questions that do not disturb the turn.
 *
 * Answering is backend-dependent and deliberately degrades rather than fails:
 *
 * - When the thread's provider exposes a native side-question channel and the
 *   session is still live, the question goes there. That agent shares the real
 *   session context, tool results included, so it can answer "what did that
 *   command print?".
 * - Otherwise the question is answered from codeslop's stored transcript,
 *   which holds the prose but no tool output. Weaker, and recorded as such on
 *   the aside so the UI can say which one you are reading.
 *
 * Neither backend sees the agent's reasoning. It is not persisted here, and
 * the native channel does not expose it either.
 *
 * @module aside/AsideService
 */
import {
  type Aside,
  type AsideAskInput,
  type AsideAskResult,
  type AsideContextFidelity,
  AsideError,
  AsideId,
  type AsideListInput,
  type AsideListResult,
  AsideMessage,
  AsideMessageId,
  type AsideRemoveInput,
  type AsideRemoveResult,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ThreadAsideMessageRow,
  ThreadAsideRepository,
  type ThreadAsideRow,
} from "../persistence/Services/ThreadAsides.ts";
import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  buildTranscriptAsidePrompt,
  composeNativeSideQuestion,
  deriveAsideTitle,
  renderThreadTranscript,
  type TranscriptEntry,
} from "./asidePrompt.ts";

export interface AsideServiceShape {
  readonly list: (input: AsideListInput) => Effect.Effect<AsideListResult, AsideError>;
  readonly ask: (input: AsideAskInput) => Effect.Effect<AsideAskResult, AsideError>;
  readonly remove: (input: AsideRemoveInput) => Effect.Effect<AsideRemoveResult, AsideError>;
}

export class AsideService extends Context.Service<AsideService, AsideServiceShape>()(
  "t3/aside/AsideService",
) {}

const asideError = (operation: string, detail: string, cause?: unknown) =>
  new AsideError({ operation, detail, ...(cause !== undefined ? { cause } : {}) });

function toAsideMessage(row: ThreadAsideMessageRow): AsideMessage {
  return {
    asideMessageId: row.asideMessageId,
    role: row.role,
    text: row.text,
    ...(row.synthetic ? { synthetic: true } : {}),
    createdAt: row.createdAt,
  };
}

function toAside(row: ThreadAsideRow, messages: ReadonlyArray<AsideMessage>): Aside {
  return {
    asideId: row.asideId,
    threadId: row.threadId,
    turnId: row.turnId,
    title: row.title,
    fidelity: row.fidelity,
    messages,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * An aside that was ever answered from the transcript stays labelled that way.
 * A reader deciding whether to trust a recollection cares that some answer in
 * the thread was made without tool output, not which one.
 */
function mergeFidelity(
  existing: AsideContextFidelity,
  answered: AsideContextFidelity,
): AsideContextFidelity {
  return existing === "transcript" || answered === "transcript" ? "transcript" : "session";
}

export const make = Effect.gen(function* () {
  const asides = yield* ThreadAsideRepository;
  const messages = yield* ProjectionThreadMessageRepository;
  const threads = yield* ProjectionThreadRepository;
  const projects = yield* ProjectionProjectRepository;
  const sessions = yield* ProjectionThreadSessionRepository;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const newId = (operation: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => asideError(operation, "Failed to generate an identifier.", cause)),
    );

  const repositoryError = (operation: string) => (cause: unknown) =>
    asideError(operation, "Aside storage failed.", cause);

  /** Where the transcript backend runs: the thread's worktree, else the project root. */
  const resolveCwd = (thread: { projectId: ProjectId; worktreePath: string | null }) =>
    Effect.gen(function* () {
      if (thread.worktreePath !== null && thread.worktreePath.length > 0) {
        return thread.worktreePath;
      }
      const project = yield* projects
        .getById({ projectId: thread.projectId })
        .pipe(Effect.mapError(repositoryError("ask")));
      if (Option.isNone(project)) {
        return yield* Effect.fail(
          asideError("ask", `Project '${thread.projectId}' was not found for this thread.`),
        );
      }
      return project.value.workspaceRoot;
    });

  const readAside = (asideId: AsideId, operation: string) =>
    Effect.gen(function* () {
      const row = yield* asides.get({ asideId }).pipe(Effect.mapError(repositoryError(operation)));
      if (Option.isNone(row)) {
        return yield* Effect.fail(asideError(operation, `Aside '${asideId}' was not found.`));
      }
      const messageRows = yield* asides
        .listMessagesByAsideId({ asideId })
        .pipe(Effect.mapError(repositoryError(operation)));
      return toAside(row.value, messageRows.map(toAsideMessage));
    });

  /**
   * Ask the provider's native channel. Returns `None` when that route is not
   * available — no such capability, no live session, or a runtime that rejects
   * the request — so the caller can fall back instead of failing the ask.
   */
  const tryNativeAnswer = (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
    question: string,
  ): Effect.Effect<Option.Option<{ text: string; synthetic: boolean }>> =>
    Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(instanceId);
      if (adapter.capabilities.sideQuestion !== "native" || !adapter.askSideQuestion) {
        return Option.none();
      }
      const live = yield* adapter.hasSession(threadId);
      if (!live) {
        return Option.none();
      }
      const answer = yield* adapter.askSideQuestion(threadId, question);
      return Option.some(answer);
    }).pipe(
      // Any failure here is a reason to try the weaker backend, not to lose the
      // user's question. The chosen fidelity is recorded either way.
      Effect.catchCause((cause) =>
        Effect.logDebug("Native side question unavailable; falling back to transcript.", {
          threadId,
          cause,
        }).pipe(Effect.as(Option.none())),
      ),
    );

  const transcriptAnswer = (input: {
    readonly threadId: ThreadId;
    readonly question: string;
    readonly history: ReadonlyArray<AsideMessage>;
    readonly modelSelection: AsideAskInput["modelSelection"];
    readonly cwd: string;
  }) =>
    Effect.gen(function* () {
      const rows = yield* messages
        .listByThreadId({ threadId: input.threadId })
        .pipe(Effect.mapError(repositoryError("ask")));

      const entries: ReadonlyArray<TranscriptEntry> = rows.map((row) => ({
        role: row.role,
        text: row.text,
      }));

      const prompt = buildTranscriptAsidePrompt({
        transcript: renderThreadTranscript(entries),
        history: input.history,
        question: input.question,
      });

      const generated = yield* textGeneration
        .generateAsideAnswer({
          cwd: input.cwd,
          prompt,
          modelSelection: input.modelSelection,
        })
        .pipe(
          Effect.mapError((cause) =>
            asideError("ask", `Could not answer the side question: ${cause.detail}`, cause),
          ),
        );

      return { text: generated.answer, synthetic: false };
    });

  const list: AsideServiceShape["list"] = Effect.fn("AsideService.list")(function* (input) {
    const rows = yield* asides
      .listByThreadId({ threadId: input.threadId })
      .pipe(Effect.mapError(repositoryError("list")));
    const messageRows = yield* asides
      .listMessagesByThreadId({ threadId: input.threadId })
      .pipe(Effect.mapError(repositoryError("list")));

    const byAside = new Map<AsideId, AsideMessage[]>();
    for (const row of messageRows) {
      const bucket = byAside.get(row.asideId);
      if (bucket) {
        bucket.push(toAsideMessage(row));
      } else {
        byAside.set(row.asideId, [toAsideMessage(row)]);
      }
    }

    return { asides: rows.map((row) => toAside(row, byAside.get(row.asideId) ?? [])) };
  });

  const ask: AsideServiceShape["ask"] = Effect.fn("AsideService.ask")(function* (input) {
    const question = input.question.trim();
    if (question.length === 0) {
      return yield* Effect.fail(asideError("ask", "A side question cannot be empty."));
    }

    // An idle or finished thread can still be asked about — the transcript
    // backend answers those — so a missing session is not an error, only a
    // reason not to try the live channel.
    const thread = yield* threads
      .getById({ threadId: input.threadId })
      .pipe(Effect.mapError(repositoryError("ask")));
    if (Option.isNone(thread)) {
      return yield* Effect.fail(asideError("ask", `Thread '${input.threadId}' was not found.`));
    }
    const session = yield* sessions
      .getByThreadId({ threadId: input.threadId })
      .pipe(Effect.mapError(repositoryError("ask")));
    const cwd = yield* resolveCwd(thread.value);

    const existing = input.asideId ? yield* readAside(input.asideId, "ask") : undefined;
    if (existing && existing.threadId !== input.threadId) {
      return yield* Effect.fail(
        asideError("ask", `Aside '${existing.asideId}' does not belong to this thread.`),
      );
    }

    const history = existing?.messages ?? [];

    // Answer before writing anything: a failed ask should leave no dangling
    // question behind, and the client still holds the text to retry with.
    const native = yield* tryNativeAnswer(
      input.threadId,
      input.modelSelection.instanceId,
      composeNativeSideQuestion(history, question),
    );

    const answered = Option.isSome(native)
      ? { ...native.value, fidelity: "session" as const }
      : {
          ...(yield* transcriptAnswer({
            threadId: input.threadId,
            question,
            history,
            modelSelection: input.modelSelection,
            cwd,
          })),
          fidelity: "transcript" as const,
        };

    const askedAt = yield* nowIso;
    const asideId = existing?.asideId ?? AsideId.make(yield* newId("ask"));

    if (!existing) {
      yield* asides
        .insert({
          asideId,
          threadId: input.threadId,
          turnId: Option.isSome(session) ? session.value.activeTurnId : null,
          title: deriveAsideTitle(question),
          fidelity: answered.fidelity,
          createdAt: askedAt,
          updatedAt: askedAt,
        })
        .pipe(Effect.mapError(repositoryError("ask")));
    }

    const nextSequence = history.length;
    yield* asides
      .appendMessage(
        {
          asideMessageId: AsideMessageId.make(yield* newId("ask")),
          asideId,
          sequence: nextSequence,
          role: "user",
          text: question,
          synthetic: false,
          createdAt: askedAt,
        },
        { asideId, updatedAt: askedAt },
      )
      .pipe(Effect.mapError(repositoryError("ask")));

    const answeredAt = yield* nowIso;
    yield* asides
      .appendMessage(
        {
          asideMessageId: AsideMessageId.make(yield* newId("ask")),
          asideId,
          sequence: nextSequence + 1,
          role: "assistant",
          text: answered.text,
          synthetic: answered.synthetic,
          createdAt: answeredAt,
        },
        { asideId, updatedAt: answeredAt },
      )
      .pipe(Effect.mapError(repositoryError("ask")));

    if (existing && mergeFidelity(existing.fidelity, answered.fidelity) !== existing.fidelity) {
      yield* asides
        .setFidelity({ asideId, fidelity: "transcript" })
        .pipe(Effect.mapError(repositoryError("ask")));
    }

    return { aside: yield* readAside(asideId, "ask") };
  });

  const remove: AsideServiceShape["remove"] = Effect.fn("AsideService.remove")(function* (input) {
    const existing = yield* readAside(input.asideId, "remove");
    if (existing.threadId !== input.threadId) {
      return yield* Effect.fail(
        asideError("remove", `Aside '${input.asideId}' does not belong to this thread.`),
      );
    }
    yield* asides
      .deleteById({ asideId: input.asideId })
      .pipe(Effect.mapError(repositoryError("remove")));
    return {};
  });

  return { list, ask, remove } satisfies AsideServiceShape;
});

export const layer = Layer.effect(AsideService, make);
