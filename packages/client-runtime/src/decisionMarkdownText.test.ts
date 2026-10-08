import { describe, expect, it } from "vite-plus/test";

import { markdownBlockText } from "./decisionMarkdownText.ts";

describe("markdownBlockText", () => {
  it("turns bullets and numbered items into plain lines", () => {
    expect(markdownBlockText("- **Magnet** set #288\n  - nested\n1. first\n2) second")).toBe(
      "• Magnet set #288\n  • nested\n1. first\n2. second",
    );
  });

  it("turns a table into one line per row without its rule", () => {
    expect(
      markdownBlockText(
        "| set | mass |\n| --- | :---: |\n| **magnet** | 69 g |\n| slider | 90 g |",
      ),
    ).toBe("set | mass\nmagnet | 69 g\nslider | 90 g");
  });

  it("drops heading hashes, quote marks and code ticks but keeps links and images", () => {
    expect(markdownBlockText("## Why\n> see [mock](http://x/y) `now`\n![a](/attachments/z)")).toBe(
      "Why\nsee [mock](http://x/y) now\n![a](/attachments/z)",
    );
  });

  it("leaves a plain sentence alone, including a lone asterisk", () => {
    expect(markdownBlockText("5 * 3 is 15, and so it goes.")).toBe("5 * 3 is 15, and so it goes.");
  });
});
