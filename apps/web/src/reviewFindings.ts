import { sha256 } from "@noble/hashes/sha2";

/**
 * A single entry from a code review report. `/code-review` (and the review agents built on it)
 * end their turn with a JSON array of these, so the chat renders that array as a list of places
 * to go rather than as a wall of quoted JSON.
 *
 * The field names mirror the review contract on the wire — `failure_scenario` included — and the
 * optional ones come from the harness `ReportFindings` tool, which reports the same finding with
 * a category and a verify verdict attached.
 */
export interface ReviewFinding {
  readonly file: string;
  readonly line: number | null;
  readonly summary: string;
  readonly failureScenario: string | null;
  readonly category: string | null;
  readonly verdict: string | null;
}

/** A change request a finding can be shown against: `owner/repo` on a host, and its number. */
export interface ReviewPullRequestReference {
  readonly host: string | null;
  readonly repository: string | null;
  readonly number: number;
}

const PULL_REQUEST_URL_PATTERN =
  /https?:\/\/([^\s/]+)\/([^\s/]+\/[^\s/]+)\/pull\/(\d{1,9})(?![\d])/i;
// Only a spelled-out pull request is claimed. A bare `#123` is as likely an issue, a comment or a
// heading number, and a wrong number opens the wrong diff — worse than opening nothing.
const PULL_REQUEST_PHRASE_PATTERN = /\b(?:pull request|PR)\s*#?\s*(\d{1,9})(?![\d])/i;

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readLine(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0
    ? numeric
    : null;
}

function parseFinding(entry: unknown): ReviewFinding | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const file = trimmedString(record.file);
  const summary = trimmedString(record.summary);
  if (!file || !summary) return null;

  return {
    file,
    line: readLine(record.line),
    summary,
    failureScenario:
      trimmedString(record.failure_scenario) ?? trimmedString(record.failureScenario),
    category: trimmedString(record.category),
    verdict: trimmedString(record.verdict),
  };
}

/**
 * The findings behind a fenced JSON block, or null for any other JSON.
 *
 * Every entry has to carry a file and a summary before the block is claimed: a review report is
 * only recognisable by its shape, and rendering an unrelated array as findings would hide data
 * the reader asked to see as JSON. A partially valid array is not a review report either — one
 * unparsed entry means the whole block stays a code block, so nothing is silently dropped.
 */
export function parseReviewFindings(source: string): ReadonlyArray<ReviewFinding> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }

  // Both spellings the reviewers use: the bare array `/code-review` prints, and the
  // `{findings: [...]}` envelope the ReportFindings tool call carries.
  const wrapped =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { readonly findings?: unknown }).findings
      : undefined;
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(wrapped) ? wrapped : null;
  if (entries === null || entries.length === 0) return null;

  const findings: ReviewFinding[] = [];
  for (const entry of entries) {
    const finding = parseFinding(entry);
    if (!finding) return null;
    findings.push(finding);
  }
  return findings;
}

/**
 * The change request a review report is about, read from the words around it — the reviewer names
 * its target ("Reviewed PR #2292", or the full URL) before listing what it found. A URL also
 * carries the host and repository, which is what makes a link possible when the thread's own
 * project is not the repository under review.
 */
export function parseReviewPullRequestReference(text: string): ReviewPullRequestReference | null {
  const url = PULL_REQUEST_URL_PATTERN.exec(text);
  if (url) {
    const number = Number(url[3]);
    if (Number.isSafeInteger(number) && number > 0) {
      return {
        host: url[1]?.toLowerCase() ?? null,
        repository: url[2]?.toLowerCase() ?? null,
        number,
      };
    }
  }

  const phrase = PULL_REQUEST_PHRASE_PATTERN.exec(text);
  const number = Number(phrase?.[1]);
  return Number.isSafeInteger(number) && number > 0
    ? { host: null, repository: null, number }
    : null;
}

/** GitHub itself, or an Enterprise install named after it. */
export function isGithubReviewHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "github.com" || normalized.endsWith(".github.com") || normalized === "github"
  );
}

function normalizeFindingPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** A pull request's diff on GitHub. */
export function buildGithubPullRequestFilesUrl(input: {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}): string {
  const host = input.host === "github" ? "github.com" : input.host;
  return `https://${host}/${input.repository}/pull/${input.number}/files`;
}

/**
 * Where GitHub shows a file in a pull request's diff. The per-file anchor is `diff-` followed by
 * the SHA-256 of the path as the diff spells it, and `R<line>` picks the line on the post-change
 * side — the side a review's line numbers count in.
 */
export function buildGithubPullRequestFileUrl(input: {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly file: string;
  readonly line: number | null;
}): string {
  const path = normalizeFindingPath(input.file);
  const digest = Array.from(sha256(new TextEncoder().encode(path)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const line = input.line === null ? "" : `R${input.line}`;
  return `${buildGithubPullRequestFilesUrl(input)}#diff-${digest}${line}`;
}

/** `path/to/file.ts:51`, the spelling every editor, terminal and reviewer here already uses. */
export function formatReviewFindingLocation(finding: ReviewFinding): string {
  const path = normalizeFindingPath(finding.file);
  return finding.line === null ? path : `${path}:${finding.line}`;
}

/** One finding as markdown, so a copied finding pastes as a readable comment. */
export function formatReviewFindingMarkdown(finding: ReviewFinding): string {
  return [
    `**${formatReviewFindingLocation(finding)}** — ${finding.summary}`,
    ...(finding.failureScenario ? ["", finding.failureScenario] : []),
  ].join("\n");
}

/** Every finding as markdown, numbered the way the list numbers them. */
export function formatReviewFindingsMarkdown(findings: ReadonlyArray<ReviewFinding>): string {
  return findings
    .map((finding, index) => `${index + 1}. ${formatReviewFindingMarkdown(finding)}`)
    .join("\n\n");
}
