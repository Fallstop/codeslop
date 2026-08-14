import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { PersistedComposerImageAttachment } from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";
import {
  applyQueueIntent,
  type QueueIntent,
  type QueuedTurn,
  type QueuedTurnContent,
} from "./threadQueue";

export const THREAD_QUEUE_STORAGE_KEY = "t3code:thread-queue:v1";
const THREAD_QUEUE_STORAGE_VERSION = 1;

/**
 * Ceiling on queued turns per thread. A queue this deep has stopped being a
 * short wait for the current turn and become a plan, which belongs in the
 * prompt rather than in the composer.
 */
export const MAX_QUEUED_TURNS_PER_THREAD = 10;

/**
 * Budget for one entry's encoded images. localStorage is a ~5MB origin-wide
 * quota already shared with composer drafts and the prompt stash, so images
 * past the budget are dropped by name instead of taking the whole write down
 * with them. Sized to hold a before/after screenshot pair.
 */
export const MAX_QUEUED_TURN_ATTACHMENT_CHARS = 2_700_000;

const StoredQueuedTurn = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  droppedImageNames: Schema.Array(Schema.String),
  /**
   * Contexts, annotations, and settings are stored as opaque JSON: they are
   * written and read by this store alone, never merged with a payload from
   * another version of the app, and re-validating shapes the composer already
   * validated would only add a second place to keep in sync.
   */
  terminalContexts: Schema.Array(Schema.Unknown),
  elementContexts: Schema.Array(Schema.Unknown),
  previewAnnotations: Schema.Array(Schema.Unknown),
  reviewComments: Schema.Array(Schema.Unknown),
  modelSelection: Schema.Unknown,
  runtimeMode: Schema.Unknown,
  interactionMode: Schema.Unknown,
  injectedPromptEffort: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const PersistedThreadQueueState = Schema.Struct({
  entriesByThreadKey: Schema.Record(Schema.String, Schema.Array(StoredQueuedTurn)),
});

const decodePersistedThreadQueueState = Schema.decodeUnknownSync(PersistedThreadQueueState);

/**
 * Splits candidate attachments into a persistable set within the entry budget
 * plus the names of any that had to be dropped. Admitted in order so the
 * earliest-attached images win.
 */
export function partitionQueueAttachments(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): { kept: PersistedComposerImageAttachment[]; droppedNames: string[] } {
  const kept: PersistedComposerImageAttachment[] = [];
  const droppedNames: string[] = [];
  let usedChars = 0;
  for (const attachment of attachments) {
    if (usedChars + attachment.dataUrl.length > MAX_QUEUED_TURN_ATTACHMENT_CHARS) {
      droppedNames.push(attachment.name);
      continue;
    }
    usedChars += attachment.dataUrl.length;
    kept.push(attachment);
  }
  return { kept, droppedNames };
}

/**
 * Reading the `localStorage` property can itself throw `SecurityError` under a
 * storage policy or in a sandboxed iframe, so the access is guarded rather
 * than just the get/set calls. `durable` is false for the in-memory fallback:
 * writes there succeed but vanish on reload, and the composer is cleared on
 * the strength of a successful enqueue.
 */
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // Fall through to the in-memory store.
  }
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseQueueStorage, durable: storageIsDurable } = resolveBaseStorage();

/**
 * Persists the whole queue map immediately. Queueing is a deliberate
 * keystroke, not a per-character autosave, so there is nothing to coalesce
 * and the caller clears the composer on the strength of this write landing —
 * which a debounce timer could not honestly report.
 */
function persistEntries(entriesByThreadKey: Record<string, QueuedTurn[]>): boolean {
  try {
    baseQueueStorage.setItem(
      THREAD_QUEUE_STORAGE_KEY,
      JSON.stringify({
        version: THREAD_QUEUE_STORAGE_VERSION,
        state: { entriesByThreadKey },
      }),
    );
    return storageIsDurable;
  } catch (error) {
    console.error("[THREAD-QUEUE] Could not persist queue (storage quota?).", error);
    return false;
  }
}

function readPersistedEntries(): Record<string, QueuedTurn[]> | null {
  try {
    const raw = baseQueueStorage.getItem(THREAD_QUEUE_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    const decoded = decodePersistedThreadQueueState(state);
    const entriesByThreadKey: Record<string, QueuedTurn[]> = {};
    for (const [threadKey, entries] of Object.entries(decoded.entriesByThreadKey)) {
      entriesByThreadKey[threadKey] = entries.map((entry) => ({
        ...entry,
        attachments: [...entry.attachments],
        droppedImageNames: [...entry.droppedImageNames],
      })) as QueuedTurn[];
    }
    return entriesByThreadKey;
  } catch {
    return null;
  }
}

export interface EnqueueResult {
  /** The entry as it now sits in the queue (already merged, when coalesced). */
  entry: QueuedTurn;
  /** True when the content folded into an existing turn instead of adding one. */
  coalesced: boolean;
  /** False when the queue is at its cap and nothing was added. */
  accepted: boolean;
  /** False when the write will not survive a reload. */
  durable: boolean;
  /** Images that exceeded the storage budget and were not kept. */
  droppedImageNames: string[];
}

interface ThreadQueueStoreState {
  entriesByThreadKey: Record<string, QueuedTurn[]>;
  enqueue: (
    threadKey: string,
    intent: QueueIntent,
    content: QueuedTurnContent,
    identity: { id: string; createdAt: string },
  ) => EnqueueResult;
  /** Puts a dispatched entry back at the front after a failed send. */
  restoreEntryToFront: (threadKey: string, entry: QueuedTurn) => void;
  removeEntry: (threadKey: string, entryId: string) => QueuedTurn | null;
  setEntryText: (threadKey: string, entryId: string, text: string) => void;
  moveEntry: (threadKey: string, entryId: string, direction: -1 | 1) => void;
  clearThread: (threadKey: string) => void;
  clearEnvironment: (environmentId: EnvironmentId) => void;
}

function writeThreadEntries(
  entriesByThreadKey: Record<string, QueuedTurn[]>,
  threadKey: string,
  entries: QueuedTurn[],
): Record<string, QueuedTurn[]> {
  const next = { ...entriesByThreadKey };
  if (entries.length === 0) {
    delete next[threadKey];
  } else {
    next[threadKey] = entries;
  }
  return next;
}

/**
 * Commits a thread's new entry list to storage and to the store.
 *
 * A rejected write still commits in memory: the queue holds text the user
 * typed, and dropping it because the browser is out of quota would lose real
 * work. Callers get `durable: false` and surface it instead.
 */
function commitThreadEntries(
  get: () => ThreadQueueStoreState,
  set: (updater: (state: ThreadQueueStoreState) => Partial<ThreadQueueStoreState>) => void,
  threadKey: string,
  entries: QueuedTurn[],
): boolean {
  const durable = persistEntries(writeThreadEntries(get().entriesByThreadKey, threadKey, entries));
  set((state) => ({
    entriesByThreadKey: writeThreadEntries(state.entriesByThreadKey, threadKey, entries),
  }));
  return durable;
}

export const useThreadQueueStore = create<ThreadQueueStoreState>()((set, get) => ({
  entriesByThreadKey: {},

  enqueue: (threadKey, intent, content, identity) => {
    const existing = get().entriesByThreadKey[threadKey] ?? [];
    const { kept, droppedNames } = partitionQueueAttachments(content.attachments);
    const candidate: QueuedTurn = {
      ...content,
      attachments: kept,
      droppedImageNames: [...content.droppedImageNames, ...droppedNames],
      id: identity.id,
      createdAt: identity.createdAt,
    };

    // The cap only blocks turns that would *add* to the queue. Coalescing
    // into the back of a full queue is still allowed: it is the user editing
    // work they already queued, not piling on more.
    const wouldAppend = intent === "append" || existing.length === 0;
    if (wouldAppend && existing.length >= MAX_QUEUED_TURNS_PER_THREAD) {
      return {
        entry: candidate,
        coalesced: false,
        accepted: false,
        durable: false,
        droppedImageNames: droppedNames,
      };
    }

    const nextEntries = applyQueueIntent(existing, intent, candidate);
    const durable = commitThreadEntries(get, set, threadKey, nextEntries);
    return {
      entry: nextEntries[nextEntries.length - 1]!,
      coalesced: !wouldAppend,
      accepted: true,
      durable,
      droppedImageNames: droppedNames,
    };
  },

  restoreEntryToFront: (threadKey, entry) => {
    const entries = get().entriesByThreadKey[threadKey] ?? [];
    // A retry of the same entry must not double it up if something else
    // already put it back.
    if (entries.some((candidate) => candidate.id === entry.id)) return;
    commitThreadEntries(get, set, threadKey, [entry, ...entries]);
  },

  removeEntry: (threadKey, entryId) => {
    const entries = get().entriesByThreadKey[threadKey] ?? [];
    const removed = entries.find((entry) => entry.id === entryId) ?? null;
    if (!removed) return null;
    commitThreadEntries(
      get,
      set,
      threadKey,
      entries.filter((entry) => entry.id !== entryId),
    );
    return removed;
  },

  setEntryText: (threadKey, entryId, text) => {
    const entries = get().entriesByThreadKey[threadKey] ?? [];
    const index = entries.findIndex((entry) => entry.id === entryId);
    const existing = index === -1 ? undefined : entries[index];
    if (!existing) return;
    const nextEntries = [...entries];
    nextEntries[index] = { ...existing, text };
    commitThreadEntries(get, set, threadKey, nextEntries);
  },

  moveEntry: (threadKey, entryId, direction) => {
    const entries = get().entriesByThreadKey[threadKey] ?? [];
    const index = entries.findIndex((entry) => entry.id === entryId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= entries.length) return;
    const nextEntries = [...entries];
    const [moved] = nextEntries.splice(index, 1);
    nextEntries.splice(target, 0, moved!);
    commitThreadEntries(get, set, threadKey, nextEntries);
  },

  clearThread: (threadKey) => {
    if (!get().entriesByThreadKey[threadKey]) return;
    commitThreadEntries(get, set, threadKey, []);
  },

  clearEnvironment: (environmentId) => {
    const prefix = `${environmentId}:`;
    const entriesByThreadKey = get().entriesByThreadKey;
    const remaining: Record<string, QueuedTurn[]> = {};
    let removedAny = false;
    for (const [threadKey, entries] of Object.entries(entriesByThreadKey)) {
      if (threadKey.startsWith(prefix)) {
        removedAny = true;
        continue;
      }
      remaining[threadKey] = entries;
    }
    if (!removedAny) return;
    persistEntries(remaining);
    set(() => ({ entriesByThreadKey: remaining }));
  },
}));

/** Removes every queued turn belonging to an environment being disconnected. */
export function clearThreadQueueEnvironment(environmentId: EnvironmentId): void {
  useThreadQueueStore.getState().clearEnvironment(environmentId);
}

export function threadQueueKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

// Hydrate once at startup. Like the app's other persisted stores, tabs are
// last-write-wins: no cross-tab merging or storage-event syncing.
{
  const persisted = readPersistedEntries();
  if (persisted) {
    useThreadQueueStore.setState({ entriesByThreadKey: persisted });
  }
}

/**
 * Test seam: seeds the persisted payload through the same storage the store
 * reads and rehydrates, without needing a real `localStorage` global. Pass an
 * empty string to clear.
 */
export function writeThreadQueueStorageForTest(raw: string): void {
  baseQueueStorage.setItem(THREAD_QUEUE_STORAGE_KEY, raw);
  useThreadQueueStore.setState({ entriesByThreadKey: readPersistedEntries() ?? {} });
}

/** Test seam: the raw payload as written, whichever storage backs the store. */
export function readThreadQueueStorageForTest(): string | null {
  const raw = baseQueueStorage.getItem(THREAD_QUEUE_STORAGE_KEY);
  return typeof raw === "string" ? raw : null;
}
