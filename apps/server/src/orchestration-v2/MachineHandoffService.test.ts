import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MachineHandoffId,
  MessageId,
  ProjectId,
  ThreadId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as MachineHandoffService from "./MachineHandoffService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  makeMachineHandoffFakeAdapter,
  type MachineHandoffFakeAdapterOptions,
} from "./testkit/MachineHandoffFakeAdapter.ts";
import {
  awaitEvent,
  git,
  machineHandoffRuntime,
  workspaceWithRemote,
} from "./testkit/MachineHandoffRuntime.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const threadId = ThreadId.make("thread:export");
const handoffId = MachineHandoffId.make("export-1");
const handoffRef = `refs/slop/handoff/${handoffId}`;

const setup = (options: MachineHandoffFakeAdapterOptions, withRemote = true) =>
  Effect.gen(function* () {
    const fake = yield* makeMachineHandoffFakeAdapter({ reply: "Done.", ...options });
    const workspace = withRemote
      ? yield* workspaceWithRemote
      : { cwd: yield* checkpointWorkspace("machine-handoff-no-remote"), remote: null };
    return { fake, workspace, layer: machineHandoffRuntime(fake.adapter, "export") };
  });

/** A thread with one finished turn, then a handoff started on it. */
const startHandoff = (cwd: string, instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:export"),
      title: "Export",
      modelSelection: { instanceId, model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const completed = yield* awaitEvent(
      (event) => event.type === "run.updated" && event.payload.status === "completed",
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("message"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "Build the thing",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* Fiber.join(completed);
    const settled = yield* awaitEvent(
      (event) =>
        event.type === "thread.machine-handoff-updated" &&
        (event.payload.machineHandoff?.state === "ready" ||
          event.payload.machineHandoff?.state === "failed"),
    );
    yield* orchestrator.dispatch({
      type: "thread.machine-handoff.start",
      commandId: CommandId.make("handoff"),
      threadId,
      handoffId,
      target: {
        environmentId: EnvironmentId.make("environment:desktop"),
        threadId: ThreadId.make("thread:on-desktop"),
        environmentLabel: "Desktop",
      },
    });
    yield* Fiber.join(settled);
    return (yield* orchestrator.getThreadProjection(threadId)).thread.machineHandoff ?? null;
  });

const readStaged = Effect.gen(function* () {
  const service = yield* MachineHandoffService.MachineHandoffService;
  const read = yield* service.readBundle({ handoffId, offset: 0, length: 256 * 1024 });
  return { manifest: read.manifest, payload: Buffer.from(read.chunk, "base64") };
});

it.effect("stages the native session and conversation, and publishes the work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fake, workspace, layer } = yield* setup({
        nativeSessionTransfer: {
          export: ({ nativeThreadId }) =>
            Effect.succeed({
              bytes: new TextEncoder().encode(`session:${nativeThreadId}\n`),
              fileName: `rollout-${nativeThreadId}.jsonl`,
            }),
          install: () => Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const handoff = yield* startHandoff(workspace.cwd, fake.instanceId);
        assert.deepEqual([handoff?.state, handoff?.error], ["ready", undefined]);

        const { manifest, payload } = yield* readStaged;
        assert.deepEqual(manifest.native, {
          driver: fake.driver,
          nativeThreadId: fake.nativeId,
          fileName: `rollout-${fake.nativeId}.jsonl`,
          bytes: `session:${fake.nativeId}\n`.length,
        });
        assert.equal(payload.length, manifest.payloadBytes);
        const history = payload.subarray(manifest.native!.bytes).toString("utf8");
        assert.include(history, "Build the thing");
        assert.include(history, "Done.");
        assert.equal(manifest.targetThreadId, "thread:on-desktop");
        assert.equal(manifest.git.ref, handoffRef);
        // The work is on the shared remote, outside its branches.
        const published = yield* git(workspace.remote!, ["rev-parse", handoffRef]);
        assert.equal(published, manifest.git.commit);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("carries only the conversation when the provider cannot move its session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fake, workspace, layer } = yield* setup({});
      yield* Effect.gen(function* () {
        const handoff = yield* startHandoff(workspace.cwd, fake.instanceId);
        assert.deepEqual([handoff?.state, handoff?.error], ["ready", undefined]);
        const { manifest, payload } = yield* readStaged;
        assert.isNull(manifest.native);
        assert.include(payload.toString("utf8"), "Build the thing");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("refuses with a readable reason when there is no remote, publishing nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fake, workspace, layer } = yield* setup({}, false);
      yield* Effect.gen(function* () {
        const handoff = yield* startHandoff(workspace.cwd, fake.instanceId);
        assert.equal(handoff?.state, "failed");
        assert.equal(handoff?.error, "Both machines need a git remote they can reach.");
        const refs = yield* git(workspace.cwd, ["for-each-ref", "refs/slop/handoff"]);
        assert.equal(refs, "");
      }).pipe(Effect.provide(layer));
    }),
  ),
);
