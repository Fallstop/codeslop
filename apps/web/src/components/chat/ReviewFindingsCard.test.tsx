import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { parseReviewFindings } from "~/reviewFindings";
import { ReviewFindingsCard } from "./ReviewFindingsCard";

const FINDINGS =
  parseReviewFindings(
    JSON.stringify([
      {
        file: "apps/web/src/main.tsx",
        line: 51,
        summary: "Boots twice.",
        failure_scenario: "Two roots mount and the composer loses its draft.",
      },
      { file: "README.md", summary: "Stale install steps." },
    ]),
  ) ?? [];

function render(messageText: string): string {
  return renderToStaticMarkup(<ReviewFindingsCard findings={FINDINGS} messageText={messageText} />);
}

describe("ReviewFindingsCard", () => {
  it("links a finding at its line in the pull request diff", () => {
    const html = render("Reviewed https://github.com/pingdotgg/t3code/pull/2292 at xhigh effort.");

    // sha256("apps/web/src/main.tsx") is what GitHub names that file's diff.
    expect(html).toContain(
      "https://github.com/pingdotgg/t3code/pull/2292/files#diff-44decff659436a16ccdaaae62e456cd52d9f206c8628c8ca4447aa268c85e16bR51",
    );
    // A finding without a line still opens its file in the diff.
    expect(html).toContain("/pull/2292/files#diff-");
    expect(html).not.toContain("#diff-R");
  });

  it("shows the summary and the failure scenario as prose", () => {
    const html = render("Reviewed PR #2292.");

    expect(html).toContain("Boots twice.");
    expect(html).toContain("Two roots mount and the composer loses its draft.");
    expect(html).toContain("apps/web/src/main.tsx:51");
    expect(html).not.toContain("failure_scenario");
  });

  it("names no pull request when the report names none", () => {
    const html = render("Reviewed the working tree; here is what I found.");

    expect(html).not.toContain("/pull/");
    expect(html).toContain("apps/web/src/main.tsx:51");
  });
});
