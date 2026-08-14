/**
 * Thread-scoped aside UI state.
 *
 * Deliberately not persisted. The asides themselves live on the server, and
 * the only local state here is which one is on screen — restoring that across
 * a reload would pop a panel open that the user did not just ask for.
 *
 * @module asidePanelStore
 */
import type { Aside, AsideId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

import {
  type AsidePanelTarget,
  emptyThreadAsideState,
  type ThreadAsideState,
  upsertAside,
} from "./asidePanel";

interface AsidePanelStoreState {
  readonly stateByThreadKey: Record<string, ThreadAsideState>;
  readonly open: (threadKey: string, target: AsidePanelTarget) => void;
  readonly close: (threadKey: string) => void;
  readonly setAsides: (threadKey: string, asides: ReadonlyArray<Aside>) => void;
  readonly recordAside: (threadKey: string, aside: Aside) => void;
  readonly dropAside: (threadKey: string, asideId: AsideId) => void;
  readonly setPendingQuestion: (threadKey: string, question: string | null) => void;
  readonly setError: (threadKey: string, message: string | null) => void;
}

function updateThread(
  state: AsidePanelStoreState,
  threadKey: string,
  patch: (current: ThreadAsideState) => ThreadAsideState,
): Pick<AsidePanelStoreState, "stateByThreadKey"> {
  const current = state.stateByThreadKey[threadKey] ?? emptyThreadAsideState;
  return {
    stateByThreadKey: { ...state.stateByThreadKey, [threadKey]: patch(current) },
  };
}

export const useAsidePanelStore = create<AsidePanelStoreState>()((set) => ({
  stateByThreadKey: {},

  open: (threadKey, target) =>
    set((state) =>
      updateThread(state, threadKey, (current) => ({ ...current, target, errorMessage: null })),
    ),

  close: (threadKey) =>
    set((state) =>
      updateThread(state, threadKey, (current) => ({
        ...current,
        target: null,
        errorMessage: null,
      })),
    ),

  setAsides: (threadKey, asides) =>
    set((state) =>
      updateThread(state, threadKey, (current) => ({ ...current, asides, loaded: true })),
    ),

  // An answered question always becomes the panel's target: asking inside a
  // brand-new aside has to leave the panel pointing at the aside that was just
  // created, or the next follow-up would open a second one.
  recordAside: (threadKey, aside) =>
    set((state) =>
      updateThread(state, threadKey, (current) => ({
        ...current,
        asides: upsertAside(current.asides, aside),
        target: aside.asideId,
        pendingQuestion: null,
        errorMessage: null,
        loaded: true,
      })),
    ),

  dropAside: (threadKey, asideId) =>
    set((state) =>
      updateThread(state, threadKey, (current) => ({
        ...current,
        asides: current.asides.filter((aside) => aside.asideId !== asideId),
        target: current.target === asideId ? null : current.target,
      })),
    ),

  setPendingQuestion: (threadKey, question) =>
    set((state) =>
      updateThread(state, threadKey, (current) => ({ ...current, pendingQuestion: question })),
    ),

  setError: (threadKey, message) =>
    set((state) =>
      updateThread(state, threadKey, (current) => ({
        ...current,
        errorMessage: message,
        pendingQuestion: null,
      })),
    ),
}));

export function asidePanelKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

export function selectThreadAsideState(
  state: { stateByThreadKey: Record<string, ThreadAsideState> },
  threadKey: string,
): ThreadAsideState {
  return state.stateByThreadKey[threadKey] ?? emptyThreadAsideState;
}
