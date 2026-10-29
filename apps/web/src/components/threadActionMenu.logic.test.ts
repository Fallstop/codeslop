import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

describe("machine handoff items", () => {
  const desktop = { environmentId: "desktop", label: "Desktop" };
  const handoff = (
    machineHandoff: ThreadActionMenuState["machineHandoff"],
  ): ReturnType<typeof buildThreadActionMenuItems> =>
    buildThreadActionMenuItems({ ...baseState, isRunning: true, machineHandoff }).filter(
      (item) =>
        item.id.startsWith("hand") || item.id.endsWith("back") || item.id === "cancel-handoff",
    );

  it("offers a running thread straight to the only machine that can take it", () => {
    expect(handoff({ targets: [desktop], current: null })).toEqual([
      { id: "hand-off:desktop", label: "Hand off to Desktop", icon: "arrow-right-left" },
    ]);
  });

  it("lists every machine, naming why one cannot take it", () => {
    const [menu] = handoff({
      targets: [desktop, { environmentId: "pi", label: "Pi", unavailable: "Not connected" }],
      current: null,
    });
    expect(menu?.children?.map((item) => [item.label, item.disabled])).toEqual([
      ["Desktop", false],
      ["Pi (Not connected)", true],
    ]);
  });

  it("replaces the way in with the ways back once the work moved", () => {
    expect(
      handoff({ targets: [desktop], current: { status: "moving", targetLabel: "Desktop" } }).map(
        (item) => item.id,
      ),
    ).toEqual(["cancel-handoff"]);
    expect(
      handoff({ targets: [desktop], current: { status: "elsewhere", targetLabel: "Desktop" } }).map(
        (item) => item.label,
      ),
    ).toEqual(["Hand back from Desktop", "Take back here"]);
  });

  it("shows nothing where the server cannot hand off", () => {
    expect(handoff(null)).toEqual([]);
  });
});
