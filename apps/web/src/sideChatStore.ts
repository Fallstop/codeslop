/**
 * Which side chat the panel is showing, per parent thread.
 *
 * Only the selection lives here. The side chats themselves are threads, so
 * their messages, turns and status come from the ordinary thread state and
 * stream without this store knowing anything about them.
 *
 * @module sideChatStore
 */
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

interface SideChatStoreState {
  /** Parent thread key → the side chat open in its panel, or null for the list. */
  readonly openByParentKey: Record<string, ThreadId | null>;
  readonly open: (parentKey: string, threadId: ThreadId) => void;
  readonly showList: (parentKey: string) => void;
  readonly forget: (parentKey: string, threadId: ThreadId) => void;
}

export const useSideChatStore = create<SideChatStoreState>()((set) => ({
  openByParentKey: {},

  open: (parentKey, threadId) =>
    set((state) => ({ openByParentKey: { ...state.openByParentKey, [parentKey]: threadId } })),

  showList: (parentKey) =>
    set((state) => ({ openByParentKey: { ...state.openByParentKey, [parentKey]: null } })),

  // Called when a side chat is deleted out from under the panel, so the next
  // render falls back to the list instead of pointing at a thread that is gone.
  forget: (parentKey, threadId) =>
    set((state) =>
      state.openByParentKey[parentKey] === threadId
        ? { openByParentKey: { ...state.openByParentKey, [parentKey]: null } }
        : state,
    ),
}));

export function sideChatParentKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

export function selectOpenSideChatId(
  state: { openByParentKey: Record<string, ThreadId | null> },
  parentKey: string | null,
): ThreadId | null {
  return parentKey === null ? null : (state.openByParentKey[parentKey] ?? null);
}
