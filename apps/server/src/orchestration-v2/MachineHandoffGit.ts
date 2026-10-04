import type { MachineHandoffId } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Work travels as a commit under a namespace no remote fetches by default, so
 * pushing it never shows up as a branch or triggers CI.
 */
export const machineHandoffRef = (handoffId: MachineHandoffId) => `refs/slop/handoff/${handoffId}`;

/** Where the target fetches the work before checking it out. */
export const machineHandoffAdoptedRef = (handoffId: MachineHandoffId) =>
  `refs/slop/adopted/${handoffId}`;

const NETWORK_TIMEOUT_MS = 120_000;

type Git = GitVcsDriver.GitVcsDriver["Service"];

/** The remote in `cwd` whose fetch URL names the same repository as `remoteUrl`. */
export const findRemoteByUrl = Effect.fn("MachineHandoffGit.findRemoteByUrl")(function* (
  git: Git,
  cwd: string,
  remoteUrl: string,
) {
  const wanted = normalizeGitRemoteUrl(remoteUrl);
  const listed = yield* git.execute({
    operation: "MachineHandoff.listRemotes",
    cwd,
    args: ["remote", "-v"],
  });
  for (const line of listed.stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match?.[1] && match[2] && normalizeGitRemoteUrl(match[2]) === wanted) return match[1];
  }
  return null;
});

export const pushRef = (git: Git, input: { cwd: string; remote: string; ref: string }) =>
  git.execute({
    operation: "MachineHandoff.pushRef",
    cwd: input.cwd,
    args: ["push", "--force", input.remote, `${input.ref}:${input.ref}`],
    timeoutMs: NETWORK_TIMEOUT_MS,
  });

export const fetchRef = (
  git: Git,
  input: { cwd: string; remote: string; ref: string; into: string },
) =>
  git.execute({
    operation: "MachineHandoff.fetchRef",
    cwd: input.cwd,
    args: ["fetch", input.remote, `+${input.ref}:${input.into}`],
    timeoutMs: NETWORK_TIMEOUT_MS,
  });

/** Best-effort: a ref that is already gone is the goal, not a failure. */
export const deleteRefs = (git: Git, input: { cwd: string; ref: string; remote: string | null }) =>
  Effect.gen(function* () {
    yield* git
      .execute({
        operation: "MachineHandoff.deleteLocalRef",
        cwd: input.cwd,
        args: ["update-ref", "-d", input.ref],
        allowNonZeroExit: true,
      })
      .pipe(Effect.ignore);
    if (input.remote === null) return;
    yield* git
      .execute({
        operation: "MachineHandoff.deleteRemoteRef",
        cwd: input.cwd,
        args: ["push", input.remote, `:${input.ref}`],
        allowNonZeroExit: true,
        timeoutMs: NETWORK_TIMEOUT_MS,
      })
      .pipe(Effect.ignore);
  });
