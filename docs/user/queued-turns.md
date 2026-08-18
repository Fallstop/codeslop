# Queueing turns

You do not have to wait for an agent to finish before writing your next message. There are two ways
to send while a turn is running, and they do different things.

## Send vs Queue

- **Send** (`Enter`, or the send button) delivers your message **into the running turn**. The agent
  sees it mid-work and can change course. This is the normal behaviour and has not changed.
- **Queue** (`Ctrl`/`Cmd` + `Shift` + `Enter`, or the **Queue** button beside Stop) stacks your
  message as **its own turn**, to be sent once the current one finishes. Use it when the next
  instruction should only begin after the current work is done.

Every press of Queue adds another turn to the stack. Nothing is ever merged — five queued turns send
as five turns, in the order you stacked them.

## Managing the queue

Queued turns appear as numbered rows above the composer. Select a row to edit its text inline
(`Cmd`/`Ctrl` + `Enter` saves, `Escape` cancels), use the arrows to reorder, or the ✕ to drop it.
**Clear** empties the queue.

A thread holds at most ten queued turns. Past that, Queue is refused rather than silently folding
your message into an existing turn — drop one first, or send it into the running turn with `Enter`.

## When the queue waits

The queue sends automatically as each turn ends, with two exceptions where it parks and tells you
why:

- **You pressed Stop.** Interrupting is you taking over, so the queue does not fire what you queued
  a moment earlier. Press **Send now** when you are ready.
- **The thread hit an error.** Resolve it, then **Send now**.

The queue also waits, without needing you, while the agent is asking for an approval or an answer,
and while the environment is reconnecting.

## What a queued turn remembers

A queued turn keeps the model, mode, and reasoning effort that were selected when you queued it, so
switching models while you wait does not change work you already lined up. Attached images, terminal
output, element picks, and review comments all travel with it.

The queue is stored in your browser or desktop app and survives a reload. It is per-device: a turn
queued on your laptop does not appear on your phone. Very large images may not fit in local storage;
when that happens the turn is marked so you can see which images will not be sent.
