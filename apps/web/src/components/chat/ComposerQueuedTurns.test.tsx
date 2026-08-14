import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { QueuedTurn } from "~/threadQueue";
import { ComposerQueuedTurns } from "./ComposerQueuedTurns";

function entry(id: string, text: string): QueuedTurn {
  return {
    id,
    text,
    attachments: [],
    droppedImageNames: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    modelSelection: { instanceId: "codex", model: "gpt-5" } as QueuedTurn["modelSelection"],
    runtimeMode: "local" as QueuedTurn["runtimeMode"],
    interactionMode: "default" as QueuedTurn["interactionMode"],
    injectedPromptEffort: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function render(props: Partial<React.ComponentProps<typeof ComposerQueuedTurns>> = {}) {
  return renderToStaticMarkup(
    <ComposerQueuedTurns
      entries={[entry("a", "first turn"), entry("b", "second turn")]}
      holdReason="running"
      coalesceTargetId={null}
      queueShortcutLabel="⌘⇧↵"
      onEditText={() => {}}
      onRemove={() => {}}
      onMove={() => {}}
      onSendNow={() => {}}
      onClearAll={() => {}}
      {...props}
    />,
  );
}

describe("ComposerQueuedTurns", () => {
  it("renders nothing when the queue is empty", () => {
    expect(render({ entries: [] })).toBe("");
  });

  it("numbers the turns and previews each one", () => {
    const markup = render();
    expect(markup).toContain("first turn");
    expect(markup).toContain("second turn");
    expect(markup).toContain("2 turns queued, sending automatically.");
  });

  it("marks only the last turn as the coalesce target", () => {
    const markup = render({ coalesceTargetId: "b" });
    expect(markup).toContain("↵ adds here");
    expect(markup.match(/↵ adds here/g)).toHaveLength(1);
  });

  it("stays silent about the coalesce target when the composer is empty", () => {
    expect(render({ coalesceTargetId: null })).not.toContain("↵ adds here");
  });

  it("offers Send now only for holds the user has to clear", () => {
    expect(render({ holdReason: "running" })).not.toContain("Send now");
    expect(render({ holdReason: "awaiting-response" })).not.toContain("Send now");
    expect(render({ holdReason: "interrupted" })).toContain("Send now");
    expect(render({ holdReason: "error" })).toContain("Send now");
  });

  it("explains why an interrupted queue is parked", () => {
    expect(render({ holdReason: "interrupted" })).toContain("you stopped this turn");
  });

  it("disables reordering past either end of the queue", () => {
    const markup = render();
    const earlierFirst = markup.slice(
      markup.indexOf('aria-label="Move queued turn 1 earlier"') - 400,
      markup.indexOf('aria-label="Move queued turn 1 earlier"') + 40,
    );
    const laterLast = markup.slice(
      markup.indexOf('aria-label="Move queued turn 2 later"') - 400,
      markup.indexOf('aria-label="Move queued turn 2 later"') + 40,
    );
    expect(earlierFirst).toContain('disabled=""');
    expect(laterLast).toContain('disabled=""');
  });

  it("flags images that could not be stored with the turn", () => {
    const withDropped: QueuedTurn = {
      ...entry("a", "has images"),
      droppedImageNames: ["huge.png"],
    };
    expect(render({ entries: [withDropped] })).toContain(
      "Some images were not saved with this queued turn",
    );
  });
});
