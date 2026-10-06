import { describe, expect, it } from "vite-plus/test";

import { linkifyText, textLinks } from "./linkify.ts";

describe("linkifyText", () => {
  it("links http and https URLs and leaves trailing punctuation as text", () => {
    expect(
      linkifyText(
        "See http://git.home:3000/brad/chief-of-staff/issues/12. Also (https://example.com/a_b)!",
      ),
    ).toEqual([
      { kind: "text", text: "See " },
      {
        kind: "link",
        text: "http://git.home:3000/brad/chief-of-staff/issues/12",
        url: "http://git.home:3000/brad/chief-of-staff/issues/12",
      },
      { kind: "text", text: ". Also (" },
      { kind: "link", text: "https://example.com/a_b", url: "https://example.com/a_b" },
      { kind: "text", text: ")!" },
    ]);
  });

  it("keeps brackets a URL opened itself", () => {
    expect(textLinks("Docs: https://en.wikipedia.org/wiki/Pogo_(pin), then decide")).toEqual([
      "https://en.wikipedia.org/wiki/Pogo_(pin)",
    ]);
  });

  it("never links other schemes", () => {
    expect(linkifyText("javascript:alert(1) ftp://host/file file:///etc/passwd")).toEqual([
      { kind: "text", text: "javascript:alert(1) ftp://host/file file:///etc/passwd" },
    ]);
  });
});
