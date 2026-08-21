# Handing a thread to another machine

Some work outlives the machine you started it on. You are closing the laptop, the agent has half an
hour left, and there is a desktop at home that never sleeps. A **handoff** moves a running thread to
another environment so the same agent, with the same conversation, keeps going there.

You do not have to wait for the agent to finish. Handing off mid-work is the point.

## What happens when you hand off

1. The thread stops here. The agent is interrupted wherever it is, any approval it was waiting on is
   cancelled, and whatever it had already written is kept.
2. Your uncommitted work is published to `origin` as a commit on a hidden branch, so the other
   machine gets exactly what the agent had — including files you never staged.
3. The provider's own session file travels with it. That is what lets the agent pick up knowing what
   it already did, rather than re-reading everything.
4. The other machine checks out the work, installs the session, and continues.

## What travels, and what stays

**Travels:** the conversation, the agent's real memory of it, every tracked and untracked file in
the worktree, and any turns you had queued.

**Stays behind:** files git ignores — `.env`, `node_modules`, build output. The other machine
rebuilds those with the project's setup script. Terminals and dev servers keep running here and are
not moved. The tool the agent was in the middle of running is cancelled, and the agent re-runs it on
the other side.

## Which providers support it

Claude Code and Codex. Both keep a session on disk that can move.

For OpenCode, Cursor and Grok the action is shown but disabled, naming the provider. Their sessions
either live in a shared database or have no movable file, so there is nothing to carry — a handoff
would silently start a fresh conversation, which is worse than not offering it.

## Getting the thread back

A handoff is never one-way.

- **While it is in flight**, cancel it. The thread was already stopped here, so you are offered
  **Resume here** to pick it back up.
- **After it lands**, the origin thread shows **Continued on \<machine\>** with **Take back**. The
  other machine may have made changes since; your worktree here is exactly as you left it, so take
  the work back and pull if you want theirs.
- **Handing back** is the same feature run in reverse, and works for the same reason: the session
  that arrived is a real local session on that machine, not a copy pretending to be one.

Only one machine owns a thread at a time. While a handoff is in flight or has landed, this machine
refuses to start a new turn on that thread — that is what stops two agents working the same
conversation into conflicting states.

## When it will not work

- **No shared remote.** The work travels through git, so both machines need a remote they can both
  reach. A project without one cannot hand off.
- **The provider is not set up on the other machine.** The target needs the same provider installed
  and signed in.
- **The session file is missing.** codeslop checks before it stops anything, so a handoff that
  cannot carry the context refuses up front rather than stranding you.

If a transfer fails part way, the thread stays frozen here with the error shown, and you choose:
retry, cancel, or take it back. It never silently continues in a place you did not send it.
