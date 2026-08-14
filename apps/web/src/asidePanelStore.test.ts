import type { Aside, AsideId, AsideMessage } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { emptyThreadAsideState } from "./asidePanel";
import { selectThreadAsideState, useAsidePanelStore } from "./asidePanelStore";

const THREAD = "env:thread-1";

function message(role: "user" | "assistant", text: string): AsideMessage {
  return {
    asideMessageId: `${role}-${text}` as AsideMessage["asideMessageId"],
    role,
    text,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function aside(id: string, messages: AsideMessage[] = []): Aside {
  return {
    asideId: id as AsideId,
    threadId: "thread-1" as Aside["threadId"],
    turnId: null,
    title: "why?",
    fidelity: "session",
    messages,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function read(threadKey = THREAD) {
  return selectThreadAsideState(useAsidePanelStore.getState(), threadKey);
}

describe("asidePanelStore", () => {
  beforeEach(() => {
    useAsidePanelStore.setState({ stateByThreadKey: {} });
  });

  it("returns the empty state for an untouched thread", () => {
    expect(read()).toEqual(emptyThreadAsideState);
  });

  it("keeps threads independent", () => {
    useAsidePanelStore.getState().open(THREAD, "new");
    expect(read().target).toBe("new");
    expect(read("env:thread-2").target).toBeNull();
  });

  it("retargets the panel at the aside an answer created", () => {
    const store = useAsidePanelStore.getState();
    store.open(THREAD, "new");
    store.setPendingQuestion(THREAD, "what file?");
    store.recordAside(THREAD, aside("a", [message("user", "what file?")]));

    const state = read();
    expect(state.target).toBe("a");
    expect(state.pendingQuestion).toBeNull();
    expect(state.asides).toHaveLength(1);
  });

  it("replaces an aside in place when a follow-up is answered", () => {
    const store = useAsidePanelStore.getState();
    store.recordAside(THREAD, aside("a", [message("user", "one")]));
    store.recordAside(THREAD, aside("a", [message("user", "one"), message("user", "two")]));

    expect(read().asides).toHaveLength(1);
    expect(read().asides[0]?.messages).toHaveLength(2);
  });

  it("clears a pending question when an ask fails", () => {
    const store = useAsidePanelStore.getState();
    store.setPendingQuestion(THREAD, "what file?");
    store.setError(THREAD, "provider unavailable");

    expect(read().pendingQuestion).toBeNull();
    expect(read().errorMessage).toBe("provider unavailable");
  });

  it("closes the panel when the aside it was showing is deleted", () => {
    const store = useAsidePanelStore.getState();
    store.recordAside(THREAD, aside("a"));
    store.dropAside(THREAD, "a" as AsideId);

    expect(read().asides).toHaveLength(0);
    expect(read().target).toBeNull();
  });

  it("leaves the panel alone when a different aside is deleted", () => {
    const store = useAsidePanelStore.getState();
    store.setAsides(THREAD, [aside("a"), aside("b")]);
    store.open(THREAD, "a" as AsideId);
    store.dropAside(THREAD, "b" as AsideId);

    expect(read().target).toBe("a");
    expect(read().asides).toHaveLength(1);
  });

  it("marks the thread loaded once a list lands, even an empty one", () => {
    useAsidePanelStore.getState().setAsides(THREAD, []);
    expect(read().loaded).toBe(true);
  });
});
