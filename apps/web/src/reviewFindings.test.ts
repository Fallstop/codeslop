import { describe, expect, it } from "vite-plus/test";

import {
  buildGithubPullRequestFileUrl,
  formatReviewFindingLocation,
  formatReviewFindingsMarkdown,
  isGithubReviewHost,
  parseReviewFindings,
  parseReviewPullRequestReference,
} from "./reviewFindings";

const FINDINGS_JSON = JSON.stringify([
  {
    file: "src/Server/Watchful.Grpc/Interceptors/GrpcServerInterceptor.cs",
    line: 51,
    summary: "Reflection is a duplex RPC and now requires signed metadata.",
    failure_scenario: "grpcurl sends no x-signature header, so reflection fails.",
  },
  {
    file: "src/Server/Watchful.Grpc/Interceptors/GrpcServerInterceptor.cs",
    line: 42,
    summary: "No internal client signs a streaming call.",
    failure_scenario: "The first streaming RPC gets Forbidden on every call.",
  },
]);

describe("parseReviewFindings", () => {
  it("reads the array a review report prints", () => {
    const findings = parseReviewFindings(FINDINGS_JSON);
    expect(findings).toHaveLength(2);
    expect(findings?.[0]).toEqual({
      file: "src/Server/Watchful.Grpc/Interceptors/GrpcServerInterceptor.cs",
      line: 51,
      summary: "Reflection is a duplex RPC and now requires signed metadata.",
      failureScenario: "grpcurl sends no x-signature header, so reflection fails.",
      category: null,
      verdict: null,
    });
  });

  it("reads the findings envelope the ReportFindings tool carries", () => {
    const findings = parseReviewFindings(
      JSON.stringify({
        level: "xhigh",
        findings: [
          {
            file: "apps/web/src/main.tsx",
            line: 3,
            summary: "Boots twice.",
            failure_scenario: "Two roots mount.",
            category: "correctness",
            verdict: "CONFIRMED",
          },
        ],
      }),
    );
    expect(findings?.[0]).toMatchObject({ category: "correctness", verdict: "CONFIRMED" });
  });

  it("keeps a finding without a line", () => {
    const findings = parseReviewFindings(
      JSON.stringify([{ file: "README.md", summary: "Stale install steps." }]),
    );
    expect(findings?.[0]).toMatchObject({ line: null, failureScenario: null });
  });

  it("leaves unrelated JSON alone", () => {
    expect(parseReviewFindings(JSON.stringify([{ id: 1, name: "row" }]))).toBeNull();
    expect(parseReviewFindings(JSON.stringify({ ok: true }))).toBeNull();
    expect(parseReviewFindings("[]")).toBeNull();
    expect(parseReviewFindings("[{ not json")).toBeNull();
  });

  it("leaves a partly valid array alone rather than dropping entries", () => {
    expect(
      parseReviewFindings(JSON.stringify([{ file: "a.ts", summary: "Real." }, { file: "b.ts" }])),
    ).toBeNull();
  });
});

describe("parseReviewPullRequestReference", () => {
  it("reads the number a review names", () => {
    expect(
      parseReviewPullRequestReference("Reviewed PR #2292 (`codex/grpc-server`) at xhigh effort."),
    ).toEqual({ host: null, repository: null, number: 2292 });
  });

  it("reads a spelled-out pull request", () => {
    expect(parseReviewPullRequestReference("Reviewed pull request 17 on this branch.")).toEqual({
      host: null,
      repository: null,
      number: 17,
    });
  });

  it("prefers a URL, which also names the repository", () => {
    expect(
      parseReviewPullRequestReference(
        "Reviewed https://github.com/pingdotgg/t3code/pull/6209/files — PR #99 is unrelated.",
      ),
    ).toEqual({ host: "github.com", repository: "pingdotgg/t3code", number: 6209 });
  });

  it("ignores a bare hash number", () => {
    expect(parseReviewPullRequestReference("Fixes #4244 and cleans up the log.")).toBeNull();
  });
});

describe("buildGithubPullRequestFileUrl", () => {
  it("anchors on the file digest and the post-change line", () => {
    expect(
      buildGithubPullRequestFileUrl({
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 2292,
        file: "./apps/web/src/main.tsx",
        line: 51,
      }),
      // sha256("apps/web/src/main.tsx"), which is what GitHub names that file's diff.
    ).toBe(
      "https://github.com/pingdotgg/t3code/pull/2292/files#diff-44decff659436a16ccdaaae62e456cd52d9f206c8628c8ca4447aa268c85e16bR51",
    );
  });

  it("drops the line anchor when the finding has no line", () => {
    const url = buildGithubPullRequestFileUrl({
      host: "github.com",
      repository: "acme/app",
      number: 7,
      file: "README.md",
      line: null,
    });
    expect(url.endsWith("R")).toBe(false);
    expect(url).toContain("/pull/7/files#diff-");
  });
});

describe("isGithubReviewHost", () => {
  it("accepts github and its subdomains", () => {
    expect(isGithubReviewHost("github.com")).toBe(true);
    expect(isGithubReviewHost("GitHub.com")).toBe(true);
    expect(isGithubReviewHost("gitlab.com")).toBe(false);
  });
});

describe("formatting", () => {
  it("writes a location the way editors and terminals write one", () => {
    const findings = parseReviewFindings(FINDINGS_JSON) ?? [];
    expect(formatReviewFindingLocation(findings[0]!)).toBe(
      "src/Server/Watchful.Grpc/Interceptors/GrpcServerInterceptor.cs:51",
    );
  });

  it("numbers copied findings the way the list numbers them", () => {
    const findings = parseReviewFindings(FINDINGS_JSON) ?? [];
    expect(formatReviewFindingsMarkdown(findings)).toMatch(/^1\. \*\*src\//);
    expect(formatReviewFindingsMarkdown(findings)).toContain("\n\n2. **src/");
  });
});
