import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import ChatMarkdown from "./ChatMarkdown";

const REPORT = [
  {
    file: "apps/web/src/main.tsx",
    line: 51,
    summary: "Boots twice.",
    failure_scenario: "Two roots mount.",
  },
];

function render(text: string, isStreaming = false): string {
  return renderToStaticMarkup(
    <ChatMarkdown text={text} cwd={undefined} isStreaming={isStreaming} />,
  );
}

function fence(value: unknown): string {
  return ["```json", JSON.stringify(value), "```", ""].join("\n");
}

describe("ChatMarkdown review findings", () => {
  it("renders a review report as findings, not as quoted JSON", () => {
    const html = render(
      `Reviewed https://github.com/pingdotgg/t3code/pull/2292.\n\n${fence(REPORT)}`,
    );

    expect(html).toContain("Boots twice.");
    expect(html).toContain("Two roots mount.");
    expect(html).toContain(
      "https://github.com/pingdotgg/t3code/pull/2292/files#diff-44decff659436a16ccdaaae62e456cd52d9f206c8628c8ca4447aa268c85e16bR51",
    );
    expect(html).not.toContain("failure_scenario");
  });

  it("leaves an ordinary JSON block a code block", () => {
    const html = render(fence({ name: "t3code", version: "0.0.33" }));

    expect(html).toContain("t3code");
    expect(html).not.toContain("Review");
  });

  it("waits for the report to finish streaming", () => {
    const html = render(`Reviewed PR #2292.\n\n${fence(REPORT)}`, true);

    expect(html).toContain("failure_scenario");
  });
});
