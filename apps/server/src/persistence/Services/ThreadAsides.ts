/**
 * ThreadAsideRepository - Persistence interface for thread asides.
 *
 * Asides are authored data, not a projection: nothing replays them from the
 * orchestration event log, so these rows are the record. They are written a
 * message at a time (question, then answer) and read back whole.
 *
 * @module ThreadAsideRepository
 */
import {
  AsideContextFidelity,
  AsideId,
  AsideMessageId,
  AsideMessageRole,
  IsoDateTime,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ThreadAsideRow = Schema.Struct({
  asideId: AsideId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  title: Schema.String,
  fidelity: AsideContextFidelity,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadAsideRow = typeof ThreadAsideRow.Type;

export const ThreadAsideMessageRow = Schema.Struct({
  asideMessageId: AsideMessageId,
  asideId: AsideId,
  sequence: Schema.Int,
  role: AsideMessageRole,
  text: Schema.String,
  synthetic: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ThreadAsideMessageRow = typeof ThreadAsideMessageRow.Type;

export const InsertThreadAsideInput = ThreadAsideRow;
export type InsertThreadAsideInput = typeof InsertThreadAsideInput.Type;

export const AppendThreadAsideMessageInput = ThreadAsideMessageRow;
export type AppendThreadAsideMessageInput = typeof AppendThreadAsideMessageInput.Type;

export const TouchThreadAsideInput = Schema.Struct({
  asideId: AsideId,
  updatedAt: IsoDateTime,
});
export type TouchThreadAsideInput = typeof TouchThreadAsideInput.Type;

export const SetThreadAsideFidelityInput = Schema.Struct({
  asideId: AsideId,
  fidelity: AsideContextFidelity,
});
export type SetThreadAsideFidelityInput = typeof SetThreadAsideFidelityInput.Type;

export const ListThreadAsidesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListThreadAsidesInput = typeof ListThreadAsidesInput.Type;

export const GetThreadAsideInput = Schema.Struct({
  asideId: AsideId,
});
export type GetThreadAsideInput = typeof GetThreadAsideInput.Type;

export const DeleteThreadAsideInput = Schema.Struct({
  asideId: AsideId,
});
export type DeleteThreadAsideInput = typeof DeleteThreadAsideInput.Type;

export const DeleteThreadAsidesByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteThreadAsidesByThreadInput = typeof DeleteThreadAsidesByThreadInput.Type;

/**
 * ThreadAsideRepositoryShape - Service API for aside persistence.
 */
export interface ThreadAsideRepositoryShape {
  /** Create the aside header. Messages are appended separately. */
  readonly insert: (
    input: InsertThreadAsideInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Append one message and stamp the parent aside's `updated_at`. */
  readonly appendMessage: (
    input: AppendThreadAsideMessageInput,
    touch: TouchThreadAsideInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Record which backend answered. Called when a later answer in an existing
   * aside came from a weaker context than earlier ones.
   */
  readonly setFidelity: (
    input: SetThreadAsideFidelityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Read one aside header. */
  readonly get: (
    input: GetThreadAsideInput,
  ) => Effect.Effect<Option.Option<ThreadAsideRow>, ProjectionRepositoryError>;

  /** Aside headers for a thread, oldest first. */
  readonly listByThreadId: (
    input: ListThreadAsidesInput,
  ) => Effect.Effect<ReadonlyArray<ThreadAsideRow>, ProjectionRepositoryError>;

  /** Every message of every aside on a thread, ordered by aside then sequence. */
  readonly listMessagesByThreadId: (
    input: ListThreadAsidesInput,
  ) => Effect.Effect<ReadonlyArray<ThreadAsideMessageRow>, ProjectionRepositoryError>;

  /** Messages of one aside, ordered by sequence. */
  readonly listMessagesByAsideId: (
    input: GetThreadAsideInput,
  ) => Effect.Effect<ReadonlyArray<ThreadAsideMessageRow>, ProjectionRepositoryError>;

  /** Delete one aside and its messages. */
  readonly deleteById: (
    input: DeleteThreadAsideInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Delete every aside on a thread; called when the thread itself goes. */
  readonly deleteByThreadId: (
    input: DeleteThreadAsidesByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ThreadAsideRepository - Service tag for aside persistence.
 */
export class ThreadAsideRepository extends Context.Service<
  ThreadAsideRepository,
  ThreadAsideRepositoryShape
>()("t3/persistence/Services/ThreadAsides/ThreadAsideRepository") {}
