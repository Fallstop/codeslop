/**
 * The one command that spans two environments.
 *
 * Every other command in the app targets a single environment, so
 * `createEnvironmentCommand` pins one id. A handoff cannot: it reads from the
 * origin and writes to the target. `EnvironmentRegistry.run` strips only
 * `EnvironmentSupervisor` from an effect's requirements, so calls for two ids
 * nest freely inside one effect — that is what makes this legal rather than a
 * special case.
 *
 * Concurrency is `singleFlight` keyed on the handoff id: a bundle must be
 * couriered once, and re-renders or a second component mount must join the
 * running transfer rather than start another.
 *
 * @module state/handoffCommands
 */
import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type HandoffId,
  type ThreadHandoffLink,
  type ThreadHandoffStage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  completeThreadHandoff,
  createThread,
  failThreadHandoff,
  stageThreadHandoff,
  startThreadTurn,
  type CreateThreadInput,
  type StartThreadTurnInput,
} from "../operations/commands.ts";
import { request } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { runHandoffTransfer } from "../operations/handoffTransfer.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  type AtomCommandScheduler,
} from "./runtime.ts";

/**
 * Ports on this operation span five unrelated RPC error types across two
 * servers; naming the union buys nothing over one tagged wrapper the caller
 * can render.
 */
export class HandoffTransferError extends Data.TaggedError("HandoffTransferError")<{
  readonly message: string;
}> {}

function describeCause(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "The transfer failed.";
}

export interface RunHandoffInput {
  readonly handoffId: HandoffId;
  readonly origin: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly target: ThreadHandoffLink;
  /** An existing checkout of the same repository on the target machine. */
  readonly repositoryPath: string;
  readonly branch: string;
  /** The thread.create the target needs, minus what this fills in. */
  readonly createInput: Omit<CreateThreadInput, "threadId" | "worktreePath" | "continuedFrom">;
  readonly continuedFrom: ThreadHandoffLink;
  /** First turn to send on the target, if the user asked to start immediately. */
  readonly firstTurn: Omit<StartThreadTurnInput, "threadId"> | null;
}

export function createHandoffCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto | R, E>,
  options?: { readonly scheduler?: AtomCommandScheduler },
) {
  const scheduler = options?.scheduler ?? createAtomCommandScheduler();
  return {
    run: createRuntimeCommand(runtime, {
      label: "environment-data:commands:handoff:run",
      scheduler,
      concurrency: {
        mode: "singleFlight" as const,
        key: (input: RunHandoffInput) => input.handoffId,
      },
      execute: (input: RunHandoffInput) =>
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          // Captured so effects handed to registry.run still carry everything
          // except the supervisor it swaps in.
          const context = yield* Effect.context<
            EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto
          >();
          const inEnvironment = <A, EE>(
            environmentId: EnvironmentId,
            effect: Effect.Effect<
              A,
              EE,
              EnvironmentSupervisor | EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto
            >,
          ): Effect.Effect<A, HandoffTransferError> =>
            registry.run(environmentId, effect).pipe(
              Effect.provide(context),
              // One tagged failure so the banner has something to render; the
              // underlying union spans five unrelated RPC error types.
              Effect.mapError(
                (cause) => new HandoffTransferError({ message: describeCause(cause) }),
              ),
            );

          const originId = input.origin.environmentId;
          const targetId = input.target.environmentId;

          return yield* runHandoffTransfer({
            handoffId: input.handoffId,
            targetThreadId: input.target.threadId,
            repositoryPath: input.repositoryPath,
            // Null: only the target machine knows its worktrees directory.
            worktreePath: null,
            branch: input.branch,
            startImmediately: input.firstTurn !== null,
            ports: {
              readBundle: (payload) =>
                inEnvironment(
                  originId,
                  request(ORCHESTRATION_WS_METHODS.readHandoffBundle, payload),
                ),
              writeBundle: (payload) =>
                inEnvironment(
                  targetId,
                  request(ORCHESTRATION_WS_METHODS.writeHandoffBundle, payload),
                ),
              adoptBundle: (payload) =>
                inEnvironment(
                  targetId,
                  request(ORCHESTRATION_WS_METHODS.adoptHandoffBundle, {
                    ...payload,
                    worktreePath: null,
                  }),
                ),
              reportStage: (stage: ThreadHandoffStage) =>
                inEnvironment(
                  originId,
                  stageThreadHandoff({
                    threadId: input.origin.threadId,
                    handoffId: input.handoffId,
                    stage,
                  }),
                ),
              createContinuationThread: ({ threadId, worktreePath }) =>
                inEnvironment(
                  targetId,
                  createThread({
                    ...input.createInput,
                    threadId,
                    worktreePath,
                    continuedFrom: input.continuedFrom,
                  }),
                ),
              startContinuationTurn: ({ threadId }) =>
                input.firstTurn === null
                  ? Effect.void
                  : inEnvironment(targetId, startThreadTurn({ ...input.firstTurn, threadId })),
              completeHandoff: () =>
                inEnvironment(
                  originId,
                  completeThreadHandoff({
                    threadId: input.origin.threadId,
                    target: input.target,
                  }),
                ),
              reportFailure: ({ stage, error }) =>
                inEnvironment(
                  originId,
                  failThreadHandoff({
                    threadId: input.origin.threadId,
                    handoffId: input.handoffId,
                    stage,
                    error,
                  }),
                ),
            },
          });
        }),
    }),
  };
}
