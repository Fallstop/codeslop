/**
 * The command that spans two environments: it reads from the origin and
 * writes to the target. `EnvironmentRegistry.run` only swaps the supervisor,
 * so calls for two environments nest freely inside one effect.
 *
 * `singleFlight` on the handoff id: a bundle is carried once, and a second
 * "Continue" or a re-render joins the running transfer instead of starting
 * another.
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type MachineHandoffId,
  type OrchestrationV2MachineHandoff,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  completeMachineHandoff,
  failMachineHandoff,
  retryMachineHandoff,
  startMachineHandoff,
} from "../operations/commands.ts";
import {
  describeMachineHandoffFailure,
  runMachineHandoff,
  type MachineHandoffProgress,
} from "../operations/machineHandoff.ts";
import { request } from "../rpc/client.ts";
import { createAtomCommandScheduler, createRuntimeCommand } from "./runtime.ts";

/** One readable failure for the banner; the causes span several RPC error types. */
export class MachineHandoffTransferError extends Data.TaggedError("MachineHandoffTransferError")<{
  readonly message: string;
}> {}

export interface RunMachineHandoffInput {
  readonly handoffId: MachineHandoffId;
  readonly origin: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly environmentLabel?: string | undefined;
    readonly projectId: ProjectId;
  };
  /** Start a turn on the target that picks the work back up. */
  readonly continueWork: boolean;
  /**
   * start: freeze and stage the thread. retry: stage a failed handoff again.
   * resume: carry a handoff that is already staged.
   */
  readonly mode: "start" | "retry" | "resume";
}

type HandoffShell = {
  readonly machineHandoff?: OrchestrationV2MachineHandoff | null | undefined;
} | null;

/** Resolves with the first value `select` accepts, as the atom changes. */
function awaitAtomValue<A, B>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  select: (value: A) => B | undefined,
): Effect.Effect<B> {
  return Effect.callback<B>((resume) => {
    let done = false;
    const check = (value: A) => {
      if (done) return;
      const selected = select(value);
      if (selected === undefined) return;
      done = true;
      resume(Effect.succeed(selected));
    };
    const unsubscribe = registry.subscribe(atom, check);
    check(registry.get(atom));
    return Effect.sync(unsubscribe);
  });
}

export function createMachineHandoffCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto | R, E>,
  options: {
    readonly threadShellAtom: (ref: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) => Atom.Atom<HandoffShell>;
  },
) {
  const progressAtom = Atom.family((_handoffId: string) =>
    Atom.make<MachineHandoffProgress | null>(null).pipe(Atom.keepAlive),
  );
  const run = createRuntimeCommand(runtime, {
    label: "environment-data:commands:machine-handoff:run",
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "singleFlight" as const,
      key: (input: RunMachineHandoffInput) => input.handoffId,
    },
    execute: (input: RunMachineHandoffInput, registry) =>
      Effect.gen(function* () {
        const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
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
        ) =>
          environments.run(environmentId, effect).pipe(
            Effect.provide(context),
            Effect.mapError(
              (cause) =>
                new MachineHandoffTransferError({ message: describeMachineHandoffFailure(cause) }),
            ),
          );
        const origin = input.origin;
        const target = {
          environmentId: input.target.environmentId,
          threadId: input.target.threadId,
          ...(input.target.environmentLabel === undefined
            ? {}
            : { environmentLabel: input.target.environmentLabel }),
        };
        const handoffId = input.handoffId;
        const shellAtom = options.threadShellAtom(origin);
        // Starting or retrying gives the record a new start time; only an
        // outcome of that attempt counts, not the state it replaces.
        const before = registry.get(shellAtom)?.machineHandoff;
        const previousStart =
          input.mode === "resume" || before?.id !== handoffId ? undefined : before.startedAt;
        let seen = input.mode === "resume";
        return yield* runMachineHandoff({
          resume: input.mode === "resume",
          ports: {
            start: inEnvironment(
              origin.environmentId,
              input.mode === "retry"
                ? retryMachineHandoff({ threadId: origin.threadId, handoffId })
                : startMachineHandoff({ threadId: origin.threadId, handoffId, target }),
            ),
            awaitStaged: awaitAtomValue(
              registry,
              shellAtom,
              (shell): OrchestrationV2MachineHandoff | null | undefined => {
                const handoff = shell?.machineHandoff ?? null;
                if (handoff?.id === handoffId && handoff.startedAt !== previousStart) {
                  seen = true;
                  return handoff.state === "exporting" ? undefined : handoff;
                }
                // Gone after we saw it: cancelled from another device.
                return seen && handoff?.id !== handoffId ? null : undefined;
              },
            ),
            readBundle: (slice) =>
              inEnvironment(
                origin.environmentId,
                request(ORCHESTRATION_V2_WS_METHODS.readMachineHandoffBundle, {
                  handoffId,
                  ...slice,
                }),
              ),
            writeBundle: (chunk) =>
              inEnvironment(
                target.environmentId,
                request(ORCHESTRATION_V2_WS_METHODS.writeMachineHandoffBundle, {
                  handoffId,
                  ...chunk,
                }),
              ),
            adopt: inEnvironment(
              target.environmentId,
              request(ORCHESTRATION_V2_WS_METHODS.adoptMachineHandoff, {
                handoffId,
                projectId: input.target.projectId,
                continueWork: input.continueWork,
              }),
            ),
            complete: (adopted) =>
              inEnvironment(
                origin.environmentId,
                completeMachineHandoff({
                  threadId: origin.threadId,
                  handoffId,
                  target: { ...target, threadId: adopted.threadId },
                }),
              ),
            fail: (error) =>
              inEnvironment(
                origin.environmentId,
                failMachineHandoff({ threadId: origin.threadId, handoffId, error }),
              ),
            progress: (progress) =>
              Effect.sync(() => registry.set(progressAtom(handoffId), progress)),
          },
        }).pipe(
          Effect.ensuring(Effect.sync(() => registry.set(progressAtom(handoffId), null))),
          Effect.mapError((cause) =>
            cause instanceof MachineHandoffTransferError
              ? cause
              : new MachineHandoffTransferError({ message: cause.message }),
          ),
        );
      }),
  });
  return { run, progressAtom };
}
