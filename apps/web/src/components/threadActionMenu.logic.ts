import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "filter-by-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete"
  | "hand-off"
  | `hand-off:${string}`
  | "cancel-handoff"
  | "hand-back"
  | "take-back";

/** A machine the thread can move to, or why it cannot. */
export interface ThreadActionMenuHandoffTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly unavailable?: string;
}

export interface ThreadActionMenuHandoffState {
  readonly targets: ReadonlyArray<ThreadActionMenuHandoffTarget>;
  /** moving: in flight or parked with an error. elsewhere: landed on `targetLabel`. */
  readonly current: {
    readonly status: "moving" | "elsewhere";
    readonly targetLabel: string;
  } | null;
}

/**
 * The way in, the way out while it is in flight, and both ways back once it
 * landed. Never disabled for a running thread: moving mid-work is the point.
 */
function machineHandoffMenuItems(
  handoff: ThreadActionMenuHandoffState | null,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (handoff === null) return [];
  if (handoff.current?.status === "moving") {
    return [{ id: "cancel-handoff", label: "Cancel handoff", icon: "arrow-right-left" }];
  }
  if (handoff.current?.status === "elsewhere") {
    return [
      {
        id: "hand-back",
        label: `Hand back from ${handoff.current.targetLabel}`,
        icon: "arrow-right-left",
      },
      { id: "take-back", label: "Take back here", icon: "undo-2" },
    ];
  }
  const [only] = handoff.targets;
  if (handoff.targets.length === 1 && only !== undefined && only.unavailable === undefined) {
    return [
      {
        id: `hand-off:${only.environmentId}`,
        label: `Hand off to ${only.label}`,
        icon: "arrow-right-left",
      },
    ];
  }
  if (handoff.targets.length === 0) return [];
  return [
    {
      id: "hand-off",
      label: "Hand off to",
      icon: "arrow-right-left",
      children: handoff.targets.map((target) => ({
        id: `hand-off:${target.environmentId}` as const,
        label:
          target.unavailable === undefined
            ? target.label
            : `${target.label} (${target.unavailable})`,
        disabled: target.unavailable !== undefined,
      })),
    },
  ];
}

/** The same handoff choices as flat command palette entries; unavailable machines are left out. */
export function machineHandoffPaletteItems(
  handoff: ThreadActionMenuHandoffState | null,
): ReadonlyArray<{ readonly id: ThreadActionMenuId; readonly title: string }> {
  return machineHandoffMenuItems(handoff).flatMap((item) =>
    item.children === undefined
      ? [{ id: item.id, title: item.label }]
      : item.children
          .filter((child) => child.disabled !== true)
          .map((child) => ({ id: child.id, title: `Hand off to ${child.label}` })),
  );
}

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an attached provider, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Null where the thread's server cannot hand threads off. */
  readonly machineHandoff?: ThreadActionMenuHandoffState | null | undefined;
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  { id: "snooze:custom" as const, label: "Custom…", separatorBefore: true },
                ],
              },
        ]
      : []),
    ...machineHandoffMenuItems(state.machineHandoff ?? null),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
