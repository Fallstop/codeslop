import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    handoff: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
  handedOffToLabel: null,
  handoffUnsupportedProvider: null,
  handoffTargets: [{ id: "env-desktop", label: "Studio PC" }],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
          handoff: false,
        },
      }),
    ).toEqual(["rename", "mark-unread", "copy", "archive", "delete"]);
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = allIds({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(allIds(baseState)).not.toContain("new-thread-on-branch");
    expect(allIds(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const archiveItem = items.at(-2);
    expect(archiveItem?.id).toBe("archive");
    expect(archiveItem?.icon).toBe("archive");
    expect(archiveItem?.separatorBefore).toBe(true);
    expect(archiveItem?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  it("keeps archive available even when the environment lacks every other capability", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
          handoff: false,
        },
      }),
    ).toContain("archive");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

it("offers a handoff destination per eligible environment", () => {
  const items = allIds({
    ...baseState,
    handoffTargets: [
      { id: "env-desktop", label: "Studio PC" },
      { id: "env-server", label: "Rack" },
    ],
  });
  expect(items).toContain("handoff");
  expect(items).toContain("handoff:env-desktop");
  expect(items).toContain("handoff:env-server");
});

it("stays enabled while a turn is running", () => {
  // Handing off mid-work is the whole point; disabling it the way Archive is
  // disabled would defeat the feature.
  const items = buildThreadActionMenuItems({ ...baseState, isRunning: true });
  const handoff = items.find((item) => item.id === "handoff");
  expect(handoff?.disabled).not.toBe(true);
});

it("disables the action with no eligible destination", () => {
  const items = buildThreadActionMenuItems({ ...baseState, handoffTargets: [] });
  expect(items.find((item) => item.id === "handoff")?.disabled).toBe(true);
});

it("names the provider instead of hiding the action when it cannot move", () => {
  // A silently absent action reads as a missing feature; a named one reads as
  // a decision.
  const items = buildThreadActionMenuItems({
    ...baseState,
    handoffUnsupportedProvider: "opencode",
  });
  const handoff = items.find((item) => item.id === "handoff");
  expect(handoff?.label).toContain("opencode");
  expect(handoff?.disabled).toBe(true);
});

it("offers take-back once the work has moved", () => {
  const items = buildThreadActionMenuItems({ ...baseState, handedOffToLabel: "Studio PC" });
  expect(items.find((item) => item.id === "handoff-take-back")?.label).toBe(
    "Take back from Studio PC",
  );
  // The way in is gone while the work is away; only the way out remains.
  expect(items.some((item) => item.id === "handoff")).toBe(false);
});

it("omits handoff entirely on a server that cannot do it", () => {
  const items = allIds({
    ...baseState,
    supports: { ...baseState.supports, handoff: false },
  });
  expect(items.some((id) => id.startsWith("handoff"))).toBe(false);
});
