import { memo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import type { Aside, AsideId, ScopedThreadRef } from "@t3tools/contracts";

import { asideExchangeCount, asidePreview, fidelityPresentation } from "~/asidePanel";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface AsidesPanelProps {
  asides: ReadonlyArray<Aside>;
  loaded: boolean;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  onContinue: (asideId: AsideId) => void;
  onRemove: (asideId: AsideId) => void;
  className?: string;
}

const AsideRow = memo(function AsideRow({
  aside,
  cwd,
  threadRef,
  onContinue,
  onRemove,
}: {
  aside: Aside;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  onContinue: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const fidelity = fidelityPresentation(aside.fidelity);
  const exchanges = asideExchangeCount(aside);
  const preview = asidePreview(aside);

  return (
    <li className="rounded-xl border border-border/60 bg-card1/50">
      <div className="flex items-start gap-1.5 p-2">
        <Button
          size="xs"
          variant="ghost"
          className="mt-px size-5 shrink-0 p-0 text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${aside.title}` : `Expand ${aside.title}`}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{aside.title}</p>
          {!expanded && preview.length > 0 ? (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{preview}</p>
          ) : null}

          {expanded ? (
            <ol className="mt-2 flex flex-col gap-2">
              {aside.messages.map((message) => (
                <li key={message.asideMessageId} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-px shrink-0 text-[11px] font-medium text-muted-foreground/70"
                  >
                    {message.role === "user" ? "You" : "Aside"}
                  </span>
                  <div className="min-w-0 flex-1">
                    {message.role === "user" ? (
                      <p className="text-xs whitespace-pre-wrap text-foreground/90">
                        {message.text}
                      </p>
                    ) : message.synthetic ? (
                      <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
                        <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                        <span>{message.text}</span>
                      </p>
                    ) : (
                      <ChatMarkdown
                        text={message.text}
                        cwd={cwd}
                        threadRef={threadRef}
                        lineBreaks
                        className="text-xs"
                      />
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}

          <div className="mt-1.5 flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant={aside.fidelity === "session" ? "info" : "warning"} size="sm">
                    {fidelity.label}
                  </Badge>
                }
              />
              <TooltipPopup className="max-w-72">{fidelity.detail}</TooltipPopup>
            </Tooltip>
            <span className="text-[11px] text-muted-foreground/70">
              {exchanges} question{exchanges === 1 ? "" : "s"}
            </span>
            {expanded ? (
              <>
                <Button size="xs" variant="ghost" className="ml-auto" onClick={onContinue}>
                  Continue
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={onRemove}
                  aria-label={`Delete aside ${aside.title}`}
                >
                  <Trash2Icon />
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
});

/**
 * The review surface for a thread's saved asides.
 *
 * The half of the feature that the composer panel cannot carry: asides
 * accumulate over a long session, and the question worth re-reading is rarely
 * the one you just asked. Rows are collapsed by default and ordered oldest
 * first, so the list reads in the order the work happened.
 */
export const AsidesPanel = memo(function AsidesPanel({
  asides,
  loaded,
  cwd,
  threadRef,
  onContinue,
  onRemove,
  className,
}: AsidesPanelProps) {
  if (asides.length === 0) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2 px-6 text-center",
          className,
        )}
      >
        <MessageCircleQuestionIcon className="size-5 text-muted-foreground/60" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">
          {loaded ? "No asides on this thread yet." : "Loading asides…"}
        </p>
        {loaded ? (
          <p className="max-w-64 text-[11px] text-muted-foreground/70">
            Type <code className="font-mono">/btw</code> in the composer to ask about work in
            progress without interrupting it. Questions and answers are kept here.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("h-full overflow-y-auto p-2", className)}>
      <ul className="flex flex-col gap-1.5">
        {asides.map((aside) => (
          <AsideRow
            key={aside.asideId}
            aside={aside}
            cwd={cwd}
            threadRef={threadRef}
            onContinue={() => onContinue(aside.asideId)}
            onRemove={() => onRemove(aside.asideId)}
          />
        ))}
      </ul>
    </div>
  );
});
