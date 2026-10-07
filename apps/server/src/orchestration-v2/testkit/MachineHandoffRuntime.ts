import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as MachineHandoffService from "../MachineHandoffService.ts";
import * as Orchestrator from "../Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

export const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return (yield* spawner.string(ChildProcess.make("git", args, { cwd }))).trim();
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

/** A repository with a shared bare remote, the way two machines meet. */
export const workspaceWithRemote = Effect.gen(function* () {
  const cwd = yield* checkpointWorkspace("machine-handoff-export");
  const remote = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  yield* git(remote, ["init", "--bare"]);
  yield* git(cwd, ["remote", "add", "origin", remote]);
  yield* git(cwd, ["push", "origin", "HEAD:refs/heads/main"]);
  return { cwd, remote };
}).pipe(Effect.provide(NodeServices.layer));

/** The orchestration runtime with the real handoff service over real git. */
export const machineHandoffRuntime = (adapter: ProviderAdapterV2Shape, name: string) => {
  const gitLayer = Layer.mergeAll(GitVcsDriver.layer, RepositoryIdentityResolver.layer).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: `t3-${name}-git-` })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.orDie,
  );
  return ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    {
      machineHandoffLayer: MachineHandoffService.layer.pipe(
        Layer.provide(gitLayer),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make(`environment:${name}`),
              label: name,
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: true },
            }),
          }),
        ),
      ),
    },
  );
};

/** Resolves once an event matching `predicate` is committed. Start before dispatching. */
export const awaitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });
