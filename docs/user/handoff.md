# Handing a thread to another machine

Some work outlives the machine you started it on. You are closing the laptop, the agent has half an
hour left, and there is a desktop at home that never sleeps. **Hand off to \<machine\>** moves a thread
to another connected environment so the work keeps going there.

You do not have to wait for the agent to finish. Handing off mid-work is the point.

## How to start

Open the thread's menu (right-click it in the sidebar, or the menu in the chat header) and choose
**Hand off to \<machine\>**, or search for it in the command palette. The mobile app offers the same
action in a thread's menu. A machine is listed when it is connected, runs a codeslop version that
supports handoffs, and has the same repository open as a project. When one cannot take the thread,
the menu says why.

## What happens

1. The thread stops here. The agent is interrupted, an approval it was waiting on is cancelled, and
   queued messages stay held on this machine.
2. Your uncommitted work, including files you never staged, is pushed to the project's git remote
   under a hidden ref, so it never appears as a branch.
3. The device that started the handoff copies the conversation across, and the other machine checks
   the work out in a new worktree with the same uncommitted changes, runs the project's setup
   script, and starts the thread. If the agent was working, it is told to continue where it left
   off.

The banner above the composer follows each step. If that device goes away while the work is packed
up, any other device can finish the move with **Continue**.

## What travels

**Claude Code and Codex** carry the agent's own session, so it resumes knowing everything it did.
**Other providers** continue from the conversation instead: the agent receives your messages and its
replies as context on its first turn. The new thread tells you when that happened.

**Stays behind:** files git ignores (`.env`, `node_modules`, build output), which the setup script
rebuilds; attachments; terminals and dev servers; and queued messages, which you get back if you
take the thread back.

## Getting it back

A handoff is never one-way.

- **While it is moving**, choose **Cancel handoff**. The thread stays here, stopped. Resume its held
  queue or send a message to carry on.
- **If it failed**, the banner shows why, with **Retry** and **Cancel**.
- **After it landed**, this thread shows **Continued on \<machine\>** and keeps its history as a
  record. **Hand back** moves the work from the other machine back here as a new thread, with
  everything that machine did since. **Take back here** makes this thread active again as you left
  it; the other machine may still be running its copy, and its changes stay there.

Only one machine works a thread at a time. While a handoff is moving or has landed, this machine
does not start new turns on the thread.

## When it will not work

- **No shared remote.** Both machines need a git remote they can reach for the project.
- **The repository is not open there.** Add the project on the other machine first.
- **The provider is not set up there.** The thread continues on the same provider when the other
  machine has it, and on that machine's default otherwise, from the conversation.
