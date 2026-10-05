import { describe, expect, it } from "vite-plus/test";

import { moveEmbeddedPage, resolveEmbeddedPageHost } from "./embeddedPages.logic";

const page = (id: string) => ({ id, name: id, url: `https://${id}.example`, icon: "globe" });

describe("resolveEmbeddedPageHost", () => {
  it("uses the desktop webview whatever the scheme", () => {
    expect(
      resolveEmbeddedPageHost("http://status.home:8770", {
        desktopWebview: true,
        appProtocol: "t3code:",
      }).kind,
    ).toBe("webview");
  });

  it("refuses http pages inside an https app instead of drawing a blank frame", () => {
    const host = resolveEmbeddedPageHost("http://status.home:8770", {
      desktopWebview: false,
      appProtocol: "https:",
    });
    expect(host.kind).toBe("blocked");
  });

  it("frames http pages from an http app, https pages anywhere, and loopback from https", () => {
    const web = (url: string, appProtocol: string) =>
      resolveEmbeddedPageHost(url, { desktopWebview: false, appProtocol }).kind;
    expect(web("http://status.home:8770", "http:")).toBe("iframe");
    expect(web("https://control.example:8449", "https:")).toBe("iframe");
    expect(web("http://localhost:8770", "https:")).toBe("iframe");
  });
});

describe("moveEmbeddedPage", () => {
  it("swaps neighbours and ignores moves past either end", () => {
    const pages = [page("a"), page("b"), page("c")];
    expect(moveEmbeddedPage(pages, 2, -1).map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    expect(moveEmbeddedPage(pages, 0, -1)).toBe(pages);
    expect(moveEmbeddedPage(pages, 2, 1)).toBe(pages);
  });
});
