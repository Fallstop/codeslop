# Queueing turns

You do not have to wait for an agent to finish before writing your next message. Anything you send
to a thread that is already working joins a queue above the composer and goes out on its own as
soon as the current turn ends.

## Two ways to queue

The two send affordances differ only in where your message lands:

- **Send** (`Enter`, or the send button) adds to the turn already waiting. Send three follow-up
  thoughts and the agent receives them as one turn, separated by blank lines.
- **Queue** (`Ctrl`/`Cmd` + `Shift` + `Enter`, or the **Queue** button beside Stop) starts a new
  turn. Use it when the next instruction should only begin after the previous one is done.

While the composer has text, the turn that `Enter` would fold into is highlighted and labelled
**↵ adds here**, so you can always see which of the two you are about to do.

## Managing the queue

Each queued turn is a row above the composer, numbered in send order. Select a row to edit its text
inline (`Cmd`/`Ctrl` + `Enter` saves, `Escape` cancels), use the arrows to reorder, or the ✕ to drop
it. **Clear** empties the queue.

A thread holds at most ten queued turns. Once the queue is full, `Enter` still works — it folds into
the last turn rather than adding an eleventh.

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
