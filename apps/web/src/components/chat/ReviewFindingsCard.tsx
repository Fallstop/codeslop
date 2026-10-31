import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { type ScopedThreadRef, SourceControlProviderKind } from "@t3tools/contracts";
import { ExternalLinkIcon, FileCodeIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import {
  buildGithubPullRequestFilesUrl,
  buildGithubPullRequestFileUrl,
  formatReviewFindingLocation,
  formatReviewFindingMarkdown,
  formatReviewFindingsMarkdown,
  isGithubReviewHost,
  parseReviewPullRequestReference,
  type ReviewFinding,
} from "~/reviewFindings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProject, useThreadShell } from "~/state/entities";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MessageCopyButton } from "./MessageCopyButton";

/**
 * Where a finding's file can be opened. The pull request's diff is the point of a review, so it
 * leads whenever the report names one and the repository is on GitHub; the working copy is offered
 * beside it, and stands alone for a review of local changes.
 */
interface ReviewFindingTargets {
  readonly fileUrl: ((finding: ReviewFinding) => string) | null;
  readonly pullRequest: { readonly url: string; readonly label: string } | null;
  readonly openFile: ((finding: ReviewFinding) => void) | null;
}

function useReviewFindingTargets(
  messageText: string,
  threadRef: ScopedThreadRef | undefined,
): ReviewFindingTargets {
  const threadShell = useThreadShell(threadRef ?? null);
  const projectRef =
    threadRef && threadShell
      ? scopeProjectRef(threadRef.environmentId, threadShell.projectId)
      : null;
  const project = useProject(projectRef);

  const openFile = threadRef
    ? (finding: ReviewFinding) => {
        useRightPanelStore.getState().openFile(threadRef, finding.file, finding.line ?? undefined);
      }
    : null;

  const pullRequest = parseReviewPullRequestReference(messageText);
  if (!pullRequest) {
    return { fileUrl: null, pullRequest: null, openFile };
  }

  // A URL in the report names its own repository; a bare PR number refers to the repository
  // the thread is working in, the only other one this client can name.
  const identity = project?.repositoryIdentity;
  const host =
    pullRequest.host ??
    (identity
      ? sourceControlClients.changeRequestHost(identity, SourceControlProviderKind.make("github"))
      : null);
  const repository =
    pullRequest.repository ??
    identity?.displayName ??
    (identity?.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
  if (!host || !repository || !isGithubReviewHost(host)) {
    return { fileUrl: null, pullRequest: null, openFile };
  }

  const target = { host, repository, number: pullRequest.number };
  return {
    fileUrl: (finding: ReviewFinding) =>
      buildGithubPullRequestFileUrl({ ...target, file: finding.file, line: finding.line }),
    pullRequest: {
      url: buildGithubPullRequestFilesUrl(target),
      label: `#${pullRequest.number}`,
    },
    openFile,
  };
}

const LOCATION_CLASS_NAME =
  "min-w-0 break-all text-left font-mono text-muted-foreground text-xs transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function ReviewFindingLocation({
  finding,
  href,
  onOpenFile,
}: {
  finding: ReviewFinding;
  href: string | null;
  onOpenFile: (() => void) | null;
}) {
  const label = formatReviewFindingLocation(finding);

  if (href) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={LOCATION_CLASS_NAME}
            />
          }
        >
          {label}
          <ExternalLinkIcon aria-hidden className="ml-1 inline size-3 align-[-0.125em]" />
        </TooltipTrigger>
        <TooltipPopup side="top">Open in the pull request diff</TooltipPopup>
      </Tooltip>
    );
  }

  if (onOpenFile) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" onClick={onOpenFile} className={LOCATION_CLASS_NAME} />}
        >
          {label}
        </TooltipTrigger>
        <TooltipPopup side="top">Open the file</TooltipPopup>
      </Tooltip>
    );
  }

  return <span className={cn(LOCATION_CLASS_NAME, "hover:no-underline")}>{label}</span>;
}

const ReviewFindingRow = memo(function ReviewFindingRow({
  finding,
  index,
  targets,
}: {
  finding: ReviewFinding;
  index: number;
  targets: ReviewFindingTargets;
}) {
  const href = targets.fileUrl?.(finding) ?? null;
  const openFile = targets.openFile ? () => targets.openFile?.(finding) : null;

  return (
    <li className="group/finding grid grid-cols-[1.25rem_1fr] gap-x-2 px-3 py-2.5 sm:px-4">
      <span className="pt-px text-right font-mono text-muted-foreground text-xs tabular-nums">
        {index + 1}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <ReviewFindingLocation
            finding={finding}
            href={href}
            onOpenFile={href ? null : openFile}
          />
          <span className="-mt-1 flex shrink-0 items-center gap-0.5 opacity-64 transition-opacity focus-within:opacity-100 group-hover/finding:opacity-100">
            {href && openFile ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Open the file"
                      onClick={openFile}
                    />
                  }
                >
                  <FileCodeIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Open the file</TooltipPopup>
              </Tooltip>
            ) : null}
            <MessageCopyButton
              text={formatReviewFindingMarkdown(finding)}
              size="icon-xs"
              variant="ghost"
              label="Copy this finding"
            />
          </span>
        </div>
        <p className="mt-0.5 text-foreground text-sm leading-relaxed">{finding.summary}</p>
        {finding.failureScenario ? (
          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
            {finding.failureScenario}
          </p>
        ) : null}
      </div>
    </li>
  );
});

/**
 * Renders a `/code-review` findings array as rows that open each file in the pull request
 * diff at its line, keep the prose as prose, and copy as markdown.
 */
export const ReviewFindingsCard = memo(function ReviewFindingsCard({
  findings,
  messageText,
  threadRef,
}: {
  findings: ReadonlyArray<ReviewFinding>;
  messageText: string;
  threadRef?: ScopedThreadRef | undefined;
}) {
  const targets = useReviewFindingTargets(messageText, threadRef);

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border/80 bg-card/70">
      <div className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Review</Badge>
          <p className="truncate text-muted-foreground text-xs tabular-nums">
            {findings.length === 1 ? "1 finding" : `${findings.length} findings`}
          </p>
        </div>
        <span className="flex items-center gap-2">
          {targets.pullRequest ? (
            <a
              href={targets.pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground text-xs tabular-nums transition-colors hover:text-foreground hover:underline"
            >
              {targets.pullRequest.label}
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          ) : null}
          <MessageCopyButton
            text={formatReviewFindingsMarkdown(findings)}
            size="icon-xs"
            variant="ghost"
            label="Copy every finding"
          />
        </span>
      </div>
      <ol className="divide-y divide-border/60 border-border/60 border-t">
        {findings.map((finding, index) => (
          <ReviewFindingRow
            key={`${formatReviewFindingLocation(finding)}:${finding.summary}`}
            finding={finding}
            index={index}
            targets={targets}
          />
        ))}
      </ol>
    </div>
  );
});
