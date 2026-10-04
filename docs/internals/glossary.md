# Glossary

Terms whose meaning matters across codeslop. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent cycle, a V2 run. Provider work can end before checkpoint and diff work settles. |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished.              |
| Event                   | A persisted fact produced by a command.                                                                   |
| Orchestrator            | The service that serializes commands and decides their events from current state, without I/O.            |
| Projection / read model | A persisted view of current state, committed in the same transaction as the events that change it.        |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                                  |
| Outbox effect           | Side-effect intent committed with the events, such as starting a provider turn or capturing a checkpoint. |
| Effect worker           | The worker that runs outbox effects after commit and feeds their results back as commands.                |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime codeslop controls, such as Codex or Claude Code.                                           |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into codeslop operations and events.                   |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

#### Machine handoff

Moving a thread's work to another environment. Named `MachineHandoff*` in code to stay distinct
from provider context handoffs (switching providers within one thread) and the server-update
handoff in `cloud/http.ts`. The origin thread records it in `machineHandoff` (exporting, ready,
failed, completed); the adopted thread records `continuedFrom`. A thread with a `machineHandoff`
admits no runs. See [MachineHandoff.ts](../../apps/server/src/orchestration-v2/MachineHandoff.ts).

#### Handoff bundle

What crosses between machines: a manifest plus one checksummed payload (the provider's own session
bytes, if its adapter can move them, followed by the conversation as JSON), staged under
`<stateDir>/handoff/<handoffId>/`. The work itself travels separately as a commit under
`refs/slop/handoff/<id>` on the shared remote. The client carries the bundle in offset-addressed
chunks because servers never talk to each other.

#### Adopt

The target half of a handoff: verify the bundle (stop proof, size, checksum) before touching git,
check the work out with its changes uncommitted, install the provider session, and launch the
thread through `ThreadLaunchService`. Idempotent per handoff. See
[MachineHandoffAdoptService.ts](../../apps/server/src/orchestration-v2/MachineHandoffAdoptService.ts).

### State home

#### State home

The base directory one environment keeps its data in: the database, worktrees, caches, and secrets. Every component resolves it through the same rule in [stateHome.ts][25] — whichever candidate already holds a `state.sqlite` wins, and the current name breaks the tie. Installed apps choose between `~/.codeslop` and a pre-rebrand `~/.t3`; a linked git worktree chooses between `.slop` and `.t3` inside the worktree. `T3CODE_HOME` overrides the choice entirely.

The rule is duplicated deliberately in four places because they cannot share a runtime: [DesktopStatePaths.ts][26] resolves it synchronously before Electron is ready, [os-jank.ts][27] resolves it inside Effect, `scripts/dev-runner.ts` resolves it for dev commands, and `REMOTE_SERVER_HOME_SCRIPT` in [tunnel.ts][28] resolves it in POSIX `sh` on a remote host. They must stay in agreement: when they disagree, one machine serves two databases with two environment ids.

#### Server runtime record

`<stateDir>/server-runtime.json`, written by a server once it is listening, telling local callers (`slop pair`, the SSH reuse probe) which pid and port to talk to. There is one slot per state directory, so it names the server that clients should find. A server only clears the record while it still describes itself; a second server sharing the directory — one launched over SSH beside a running desktop app — publishes to its own path via `T3CODE_RUNTIME_STATE_PATH` instead. See [serverRuntimeState.ts][29].

[25]: ../../packages/shared/src/stateHome.ts
[26]: ../../apps/desktop/src/app/DesktopStatePaths.ts
[27]: ../../apps/server/src/os-jank.ts
[28]: ../../packages/ssh/src/tunnel.ts
[29]: ../../apps/server/src/serverRuntimeState.ts
[30]: ../../apps/server/src/environmentTheme.ts
[31]: ../user/environment-theme.md

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The worker that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.                |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

## Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.
