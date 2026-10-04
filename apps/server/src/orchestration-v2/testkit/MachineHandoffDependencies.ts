import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

/** What machine handoff export needs beyond the orchestration runtime, inert for tests that never hand off. */
export const machineHandoffDependenciesTestLayer = Layer.mergeAll(
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
    resolve: () => Effect.succeed(null),
  }),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
);
