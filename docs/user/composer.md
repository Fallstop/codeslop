# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, codeslop keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

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
