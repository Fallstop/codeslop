# Semantic chat search

Thread search in the command palette normally finds literal text: it matches your query against
thread titles and message contents character-for-character. Semantic search adds a second engine on
top — it matches by meaning, so searching "credential rotation" finds the chat where you asked "how
do I change the API keys", even though no word overlaps.

## Turning it on

Semantic search is off by default. Enable it in **Settings → Semantic search**. The first time you
turn it on, the server downloads a small embedding model (about 25 MB, one time) and shows the
download progress in the same settings section. Everything runs locally after that — no message
text ever leaves your machine.

Once the model is ready, the server indexes your existing chats in the background. Indexing runs
opportunistically while a client is in the foreground and pauses under battery/thermal pressure,
following your background-activity settings. A large history takes a few minutes to index; search
keeps working the whole time and simply gets better as coverage grows.

## How results appear

Search stays where it always was: the command palette (`Cmd`/`Ctrl` + `K`). Results now blend the
two engines:

- **Literal matches** look exactly like before, with the matching text highlighted in the snippet.
- **Semantic matches** show the most relevant passage from the conversation, ranked after direct
  matches for the same query. The snippet may not contain your query words — that is the point.

Both kinds open the thread as usual. Deleted and archived threads never appear.

## What gets indexed

Your messages and the agent's final responses, per thread. Interim streaming output, system
messages, and reasoning are not indexed. Edited messages are re-indexed automatically, and
embeddings for deleted threads are cleaned up in the background.

The index lives inside the server's local state database (`state.sqlite`) next to the chats
themselves. Turning the setting off stops indexing and semantic matching immediately; the search
falls back to exact-text matching only.
