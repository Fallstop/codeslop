import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  MessageCircleQuestionIcon,
  SendHorizonalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import type { Aside, ScopedThreadRef } from "@t3tools/contracts";

import { asideExchangeCount, fidelityPresentation } from "~/asidePanel";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerAsidePanelProps {
  /** The aside being shown, or undefined while composing the opening question. */
  aside: Aside | undefined;
  pendingQuestion: string | null;
  errorMessage: string | null;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  onAsk: (question: string) => void;
  onClose: () => void;
  className?: string;
}

function AsideExchange({
  aside,
  cwd,
  threadRef,
}: {
  aside: Aside;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  return (
    <ol className="flex flex-col gap-2">
      {aside.messages.map((message) =>
        message.role === "user" ? (
          <li key={message.asideMessageId} className="flex gap-2">
            <span
              aria-hidden="true"
              className="mt-px shrink-0 text-[11px] font-medium text-muted-foreground/70"
            >
              You
            </span>
            <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap text-foreground/90">
              {message.text}
            </p>
          </li>
        ) : (
          <li key={message.asideMessageId} className="flex gap-2">
            <span
              aria-hidden="true"
              className="mt-px shrink-0 text-[11px] font-medium text-muted-foreground/70"
            >
              Aside
            </span>
            <div className="min-w-0 flex-1">
              {message.synthetic ? (
                // Not an answer: the runtime produced this itself. Rendered as a
                // notice so it never reads as something the model actually said.
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
        ),
      )}
    </ol>
  );
}

/**
 * The asking surface for thread asides, docked above the composer.
 *
 * Lives beside the composer rather than in the right panel because asking is
 * a typing action: the question follows something the user just read in the
 * transcript, and the answer is read once and usually dropped. Reviewing old
 * asides is the other half of the feature and belongs in the panel, where
 * there is room for it.
 *
 * Closing keeps the aside. There is no discard here on purpose — the point of
 * saving them is that you did not have to decide, at the moment you asked,
 * whether the answer would matter later.
 */
export const ComposerAsidePanel = memo(function ComposerAsidePanel({
  aside,
  pendingQuestion,
  errorMessage,
  cwd,
  threadRef,
  onAsk,
  onClose,
  className,
}: ComposerAsidePanelProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isAsking = pendingQuestion !== null;

  // Focus on mount: the panel only ever opens because the user asked it to.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Clear the box once a question is accepted, not when the answer lands, so
  // the user can start typing the follow-up while the first is still running.
  useEffect(() => {
    if (isAsking) {
      setDraft("");
    }
  }, [isAsking]);

  const submit = useCallback(() => {
    const question = draft.trim();
    if (question.length === 0 || isAsking) return;
    onAsk(question);
  }, [draft, isAsking, onAsk]);

  const fidelity = aside ? fidelityPresentation(aside.fidelity) : null;
  const exchanges = aside ? asideExchangeCount(aside) : 0;

  return (
    <section
      data-composer-aside="true"
      aria-label="Aside"
      className={cn("rounded-[18px] border border-border/70 bg-card1/70 px-2 py-1.5", className)}
    >
      <header className="flex items-center gap-2 px-1 pb-1.5">
        <MessageCircleQuestionIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {aside
            ? `Aside · ${exchanges} question${exchanges === 1 ? "" : "s"}`
            : "Aside · the agent keeps working"}
        </p>
        {fidelity ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant={aside?.fidelity === "session" ? "info" : "warning"} size="sm">
                  {fidelity.label}
                </Badge>
              }
            />
            <TooltipPopup className="max-w-72">{fidelity.detail}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={onClose}
          aria-label="Close aside"
        >
          <XIcon />
        </Button>
      </header>

      {aside || pendingQuestion ? (
        <div className="max-h-64 overflow-y-auto px-1 pb-1.5">
          {aside ? <AsideExchange aside={aside} cwd={cwd} threadRef={threadRef} /> : null}
          {pendingQuestion ? (
            <div className={cn("flex gap-2", aside ? "mt-2" : "")}>
              <span
                aria-hidden="true"
                className="mt-px shrink-0 text-[11px] font-medium text-muted-foreground/70"
              >
                You
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs whitespace-pre-wrap text-foreground/90">{pendingQuestion}</p>
                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Spinner className="size-3" />
                  Answering — this does not interrupt the agent.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="px-1 pb-1.5 text-[11px] text-muted-foreground/80">
          Ask about the work in progress. The answering agent shares this thread's context, has no
          tools, and cannot change anything.
        </p>
      )}

      {errorMessage ? (
        <p className="flex items-start gap-1.5 px-1 pb-1.5 text-[11px] text-destructive-foreground">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{errorMessage}</span>
        </p>
      ) : null}

      <div className="flex items-end gap-1.5">
        <Textarea
          ref={textareaRef}
          value={draft}
          size="sm"
          rows={1}
          aria-label={aside ? "Ask a follow-up" : "Ask a side question"}
          placeholder={aside ? "Ask a follow-up…" : "What's it doing?"}
          className="min-h-8 flex-1 resize-none border-0 bg-background shadow-none ring-0"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              return;
            }
            // Enter sends: this box holds one question, not a composed prompt.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              submit();
            }
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={draft.trim().length === 0 || isAsking}
          onClick={submit}
          aria-label="Send side question"
        >
          <SendHorizonalIcon />
        </Button>
      </div>
    </section>
  );
});
