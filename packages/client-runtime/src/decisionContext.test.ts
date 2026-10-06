import { describe, expect, it } from "vite-plus/test";

import { parseDecisionContext } from "./decisionContext.ts";

const ISSUE = "http://git.home:3000/brad/t3code-fork/issues/4";

describe("parseDecisionContext", () => {
  it("turns Markdown links and bare URLs into links and keeps the prose around them", () => {
    const parsed = parseDecisionContext(
      "See [PR #77](http://git.home:3000/brad/robot/pulls/77) and https://example.com/spec.",
      ISSUE,
    );
    expect(parsed.parts).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "PR #77", url: "http://git.home:3000/brad/robot/pulls/77" },
      { kind: "text", text: " and " },
      { kind: "link", text: "https://example.com/spec", url: "https://example.com/spec" },
      { kind: "text", text: "." },
    ]);
    expect(parsed.images).toEqual([]);
  });

  it("lifts Markdown and Gitea <img> pictures out of the text, resolving relative uploads", () => {
    const parsed = parseDecisionContext(
      'The dock:\n\n![dock photo](/attachments/1b2c-3d4e)\n\n<img width="300" alt="pads" src="/attachments/9f8e">\nPick one.',
      ISSUE,
    );
    expect(parsed.images).toEqual([
      { alt: "dock photo", url: "http://git.home:3000/attachments/1b2c-3d4e" },
      { alt: "pads", url: "http://git.home:3000/attachments/9f8e" },
    ]);
    expect(parsed.parts).toEqual([{ kind: "text", text: "The dock:\n\nPick one." }]);
  });

  it("leaves non-web links as text and marks long context for an expand control", () => {
    const parsed = parseDecisionContext("[run it](javascript:void) now", ISSUE);
    expect(parsed.parts).toEqual([{ kind: "text", text: "run it now" }]);
    expect(parsed.long).toBe(false);
    expect(parseDecisionContext("word ".repeat(80), ISSUE).long).toBe(true);
  });
});
