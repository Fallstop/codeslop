import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MACHINE_HANDOFF_CHUNK_BYTES,
  MachineHandoffId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2MachineHandoffManifest,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as MachineHandoffAdoptService from "./MachineHandoffAdoptService.ts";
import * as MachineHandoffService from "./MachineHandoffService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterNativeSessionTransferError,
  type ProviderAdapterV2NativeSession,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeMachineHandoffFakeAdapter } from "./testkit/MachineHandoffFakeAdapter.ts";
import { awaitEvent, git, machineHandoffRuntime } from "./testkit/MachineHandoffRuntime.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const originThreadId = ThreadId.make("thread:laptop");
const targetThreadId = ThreadId.make("thread:desktop");
const targetProjectId = ProjectId.make("project:desktop");
const handoffId = MachineHandoffId.make("round-trip-1");
const nativeSession = new TextEncoder().encode('{"type":"session_meta"}\n');

/** Two clones of one repository that meet at a bare remote, like two laptops and GitHub. */
const repositories = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const origin = yield* checkpointWorkspace("handoff-laptop", { ".gitignore": ".env\n" });
  const remote = yield* fileSystem.makeTempDirectoryScoped();
  yield* git(remote, ["init", "--bare"]);
  yield* git(origin, ["remote", "add", "origin", remote]);
  yield* git(origin, ["push", "origin", "HEAD:refs/heads/main"]);
  const target = path.join(yield* fileSystem.makeTempDirectoryScoped(), "desktop-repo");
  yield* git(path.dirname(target), ["clone", remote, target]);
  return { origin, target, worktrees: path.join(path.dirname(target), "worktrees") };
}).pipe(Effect.provide(NodeServices.layer));

/** The receiving machine: its own orchestrator, launch flow and staging area. */
const targetMachine = (input: {
  readonly adapter: Parameters<typeof machineHandoffRuntime>[0];
  readonly repositoryRoot: string;
  readonly worktreesDir: string;
}) => {
  const orchestrator = machineHandoffRuntime(input.adapter, "desktop");
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const project = {
    id: targetProjectId,
    title: "Project",
    workspaceRoot: input.repositoryRoot,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    deletedAt: null,
  } as const;
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === targetProjectId ? Option.some(project) : Option.none()),
  });
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(Sqlite.layerMemory));
  const gitLayer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-target-git-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.orDie,
  );
  const gitWorkflow = Layer.effect(
    GitWorkflow.GitWorkflowService,
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test", cwd, args });
      // Real git for the two calls adopt makes; the rest of the workflow is unused.
      return yield* Layer.build(
        Layer.mock(GitWorkflow.GitWorkflowService)({
          listLocalBranchNames: (cwd) =>
            run(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).pipe(
              Effect.map((result) => result.stdout.split("\n").filter(Boolean)),
            ),
          createWorktree: (worktree) =>
            Effect.gen(function* () {
              const refName = worktree.newRefName ?? worktree.refName;
              const path = `${input.worktreesDir}/${refName}`;
              yield* run(worktree.cwd, ["worktree", "add", "-b", refName, path, worktree.refName]);
              return { worktree: { path, refName } };
            }),
        }),
      ).pipe(Effect.map(Context.get(GitWorkflow.GitWorkflowService)));
    }),
  ).pipe(Layer.provide(gitLayer));
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        projects,
        gitWorkflow,
        Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        Layer.mock(TextGeneration.TextGeneration)({}),
        ServerSettings.layerTest(),
        ProviderRegistryMock.layer(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          folderForThread: () => Effect.succeed(Option.none()),
        }),
        threadManagement,
        receipts,
        IdAllocator.layer,
      ),
    ),
  );
  const adopt = MachineHandoffAdoptService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        launch,
        orchestrator,
        threadManagement,
        gitWorkflow,
        gitLayer,
        projects,
        receipts,
        ProviderAdapterRegistry.layerSingle(input.adapter),
      ),
    ),
  );
  return Layer.mergeAll(adopt, orchestrator, threadManagement);
};

/** Starts a thread on the origin, lets one turn finish, edits the work, and hands it off. */
const stageOnOrigin = (cwd: string, instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: originThreadId,
      projectId: ProjectId.make("project:laptop"),
      title: "Handed off",
      modelSelection: { instanceId, model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/handoff",
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
      threadId: originThreadId,
      messageId: MessageId.make("message:first"),
      text: "Build the thing",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* Fiber.join(completed);
    // What the agent left behind: an edit, a new file, and an ignored secret.
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "# edited mid-task\n");
    yield* fileSystem.writeFileString(path.join(cwd, "notes.txt"), "untracked\n");
    yield* fileSystem.writeFileString(path.join(cwd, ".env"), "TOKEN=stay-home\n");
    const ready = yield* awaitEvent(
      (event) =>
        event.type === "thread.machine-handoff-updated" &&
        (event.payload.machineHandoff?.state === "ready" ||
          event.payload.machineHandoff?.state === "failed"),
    );
    yield* orchestrator.dispatch({
      type: "thread.machine-handoff.start",
      commandId: CommandId.make("handoff"),
      threadId: originThreadId,
      handoffId,
      target: {
        environmentId: EnvironmentId.make("environment:desktop"),
        threadId: targetThreadId,
        environmentLabel: "Desktop",
      },
    });
    yield* Fiber.join(ready);
    const handoff = (yield* orchestrator.getThreadProjection(originThreadId)).thread.machineHandoff;
    assert.deepEqual([handoff?.state, handoff?.error], ["ready", undefined]);
  }).pipe(Effect.provide(NodeServices.layer));

/** What a client does between the two machines: copy the bundle across by offset. */
const carry = (
  origin: MachineHandoffService.MachineHandoffServiceShape,
  target: MachineHandoffService.MachineHandoffServiceShape,
) =>
  Effect.gen(function* () {
    let offset = 0;
    let manifest: OrchestrationV2MachineHandoffManifest | undefined;
    while (manifest === undefined || offset < manifest.payloadBytes) {
      const read = yield* origin.readBundle({
        handoffId,
        offset,
        length: MACHINE_HANDOFF_CHUNK_BYTES,
      });
      manifest = read.manifest;
      const written = yield* target.writeBundle({
        handoffId,
        offset,
        chunk: read.chunk,
        ...(offset === 0 ? { manifest: read.manifest } : {}),
      });
      if (written.receivedBytes === offset) break;
      offset = written.receivedBytes;
    }
    return manifest;
  });

const setupMachines = (options: {
  readonly native: boolean;
  /** The first install fails, as a provider home that is briefly unwritable would. */
  readonly installFailsOnce?: boolean;
}) =>
  Effect.gen(function* () {
    const repos = yield* repositories;
    const installed: Array<{
      readonly cwd: string;
      readonly session: ProviderAdapterV2NativeSession;
    }> = [];
    const failedOnce = { value: false };
    const originFake = yield* makeMachineHandoffFakeAdapter({
      reply: "Done.",
      ...(options.native
        ? {
            nativeSessionTransfer: {
              export: () =>
                Effect.succeed({ bytes: nativeSession, fileName: "rollout-native.jsonl" }),
              install: () => Effect.void,
            },
          }
        : {}),
    });
    const targetFake = yield* makeMachineHandoffFakeAdapter({
      reply: "Resumed.",
      ...(options.native
        ? {
            nativeSessionTransfer: {
              export: () => Effect.succeed(null),
              install: ({ cwd, session, nativeThreadId }) =>
                options.installFailsOnce === true && installed.length === 0 && !failedOnce.value
                  ? Effect.sync(() => {
                      failedOnce.value = true;
                    }).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ProviderAdapterNativeSessionTransferError({
                            driver: ProviderDriverKind.make("codex"),
                            operation: "install",
                            nativeThreadId,
                          }),
                        ),
                      ),
                    )
                  : Effect.sync(() => installed.push({ cwd, session })),
            },
          }
        : {}),
    });
    const origin = yield* Layer.build(machineHandoffRuntime(originFake.adapter, "laptop"));
    const target = yield* Layer.build(
      targetMachine({
        adapter: targetFake.adapter,
        repositoryRoot: repos.target,
        worktreesDir: repos.worktrees,
      }),
    );
    yield* stageOnOrigin(repos.origin, originFake.instanceId).pipe(Effect.provideContext(origin));
    yield* carry(
      Context.get(origin, MachineHandoffService.MachineHandoffService),
      Context.get(target, MachineHandoffService.MachineHandoffService),
    );
    return { repos, installed, origin, target };
  });

const adopt = (continueWork: boolean) =>
  Effect.flatMap(MachineHandoffAdoptService.MachineHandoffAdoptService, (service) =>
    service.adopt({ handoffId, projectId: targetProjectId, continueWork }),
  );

it.effect("lands the work uncommitted with the agent's own session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { repos, installed, target } = yield* setupMachines({ native: true });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const first = yield* adopt(false);
        // A courier that lost the reply adopts again and gets the same thread.
        const again = yield* adopt(false);
        assert.deepEqual(again, first);
        assert.equal(first.threadId, targetThreadId);
        assert.equal(first.context, "native");

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const readme = yield* fileSystem.readFileString(path.join(first.worktreePath, "README.md"));
        assert.equal(readme, "# edited mid-task\n");
        assert.isFalse(yield* fileSystem.exists(path.join(first.worktreePath, ".env")));
        // Uncommitted and unstaged, exactly as the agent left it.
        assert.equal(yield* git(first.worktreePath, ["diff", "--cached", "--name-only"]), "");
        assert.equal(yield* git(first.worktreePath, ["diff", "--name-only"]), "README.md");
        assert.equal(
          yield* git(first.worktreePath, ["ls-files", "--others", "--exclude-standard"]),
          "notes.txt",
        );
        const base = yield* git(repos.origin, ["rev-parse", "HEAD"]);
        assert.equal(yield* git(first.worktreePath, ["rev-parse", "HEAD"]), base);
        assert.equal(
          yield* git(first.worktreePath, ["branch", "--show-current"]),
          "feature/handoff",
        );
        const worktrees = yield* git(repos.target, ["worktree", "list"]);
        assert.lengthOf(worktrees.split("\n"), 2);

        assert.lengthOf(installed, 1);
        assert.deepEqual(installed[0]?.session.bytes, nativeSession);
        assert.equal(installed[0]?.cwd, first.worktreePath);

        const projection = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.equal(projection.thread.continuedFrom?.context, "native");
        assert.equal(projection.thread.continuedFrom?.threadId, originThreadId);
        assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, "native-thread");
        assert.deepEqual(
          projection.turnItems.flatMap((item) =>
            item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
          ),
          ["Build the thing", "Done."],
        );

        // The resumed session already knows the conversation; nothing replays it.
        const resumed = yield* awaitEvent(
          (event) => event.type === "run.updated" && event.payload.status === "completed",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("continue"),
          threadId: targetThreadId,
          messageId: MessageId.make("message:continue"),
          text: "Keep going",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Fiber.join(resumed);
        assert.lengthOf(
          (yield* orchestrator.getThreadProjection(targetThreadId)).contextHandoffs,
          0,
        );
      }).pipe(Effect.provideContext(target), Effect.provide(NodeServices.layer));
    }),
  ),
);

it.effect("continues from the conversation when the session cannot move", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { target } = yield* setupMachines({ native: false });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const resumed = yield* awaitEvent(
          (event) => event.type === "run.updated" && event.payload.status === "completed",
        );
        const adopted = yield* adopt(true);
        assert.equal(adopted.context, "portable");
        yield* Fiber.join(resumed);
        const projection = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.equal(projection.thread.historyOrigin, "v1_import");
        // The first run carried the earlier conversation to the provider as context.
        assert.isAbove(projection.contextHandoffs.length, 0);
        assert.isTrue(
          projection.messages.some(
            (message) =>
              message.text === MachineHandoffAdoptService.MACHINE_HANDOFF_CONTINUE_PROMPT &&
              message.createdBy === "agent",
          ),
        );
      }).pipe(Effect.provideContext(target));
    }),
  ),
);

it.effect("refuses a damaged bundle before touching git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repos = yield* repositories;
      const targetFake = yield* makeMachineHandoffFakeAdapter({});
      const target = yield* Layer.build(
        targetMachine({
          adapter: targetFake.adapter,
          repositoryRoot: repos.target,
          worktreesDir: repos.worktrees,
        }),
      );
      const bundles = Context.get(target, MachineHandoffService.MachineHandoffService);
      const payload = Buffer.from("[]");
      const manifest: OrchestrationV2MachineHandoffManifest = {
        version: 1,
        handoffId,
        originEnvironmentId: EnvironmentId.make("environment:laptop"),
        originThreadId,
        targetThreadId,
        thread: {
          title: "Damaged",
          modelSelection: { instanceId: targetFake.instanceId, model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          originBranch: null,
        },
        native: null,
        historyBytes: payload.length,
        payloadBytes: payload.length,
        payloadSha256: "0".repeat(64),
        git: {
          remoteUrl: repos.target,
          ref: `refs/slop/handoff/${handoffId}`,
          commit: "0".repeat(40),
          baseCommit: "0".repeat(40),
        },
        originStoppedAt: "2026-10-05T00:00:00.000Z",
      };
      const attempt = (bundle: OrchestrationV2MachineHandoffManifest, bytes: Buffer) =>
        Effect.gen(function* () {
          yield* bundles.writeBundle({
            handoffId,
            offset: 0,
            chunk: bytes.toString("base64"),
            manifest: bundle,
          });
          return yield* adopt(false).pipe(Effect.flip);
        }).pipe(Effect.provideContext(target));

      assert.include((yield* attempt(manifest, payload)).message, "corrupted");
      assert.include(
        (yield* attempt({ ...manifest, payloadBytes: 10 }, payload)).message,
        "incomplete",
      );
      assert.include(
        (yield* attempt({ ...manifest, originStoppedAt: " " }, payload)).message,
        "stopped",
      );
      assert.equal(yield* git(repos.target, ["for-each-ref", "refs/slop"]), "");
      assert.lengthOf((yield* git(repos.target, ["worktree", "list"])).split("\n"), 1);
    }),
  ),
);

it.effect("an adopt retried after a failed install reuses the worktree it made", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { repos, installed, target } = yield* setupMachines({
        native: true,
        installFailsOnce: true,
      });
      yield* Effect.gen(function* () {
        const refused = yield* adopt(false).pipe(Effect.flip);
        assert.include(refused.message, "install");
        const adopted = yield* adopt(false);
        assert.lengthOf(installed, 1);
        assert.equal(installed[0]?.cwd, adopted.worktreePath);
        assert.lengthOf((yield* git(repos.target, ["worktree", "list"])).split("\n"), 2);
      }).pipe(Effect.provideContext(target));
    }),
  ),
);
