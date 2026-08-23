# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, codeslop keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, codeslop hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. codeslop opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Dropping files

Drop an image onto a chat to attach it to your next message. Drop any other file and codeslop adds
a link to it in the composer, so the agent can open the file where it already lives.

Those links point at a path on disk, so they only work in the desktop app when the thread runs on
that same computer. A browser never tells the page where a dropped file came from, and a path from
your computer means nothing to an agent running on another machine — in both cases the drop
reports the file as unsupported.

## Background work above the composer

Some work outlives the turn that started it — subagent fleets, workflow runs, and watch loops keep
going after the agent's reply lands. When that happens, a banner sits above the composer reading
**Background work** (or the number of agents still working, or **Monitoring** when only watch loops
are left). **Stop** ends all of it.

**Details** lists what is actually running: each task's label, its type, and how long it has been
live. That answers the awkward case where the banner is up but the Agents panel looks empty. If the
list comes back saying nothing is running, the banner is stale and a reload clears it.
