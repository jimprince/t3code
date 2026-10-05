import { describe, expect, it } from "vite-plus/test";

import {
  inlineAssets,
  localAssetReferences,
  mimeFor,
  validateManifest,
} from "./projectCanvas.logic.ts";

describe("canvas assets", () => {
  it("inlines only the page's own files and never climbs out of the canvas folder", () => {
    const html = `<link rel="stylesheet" href="canvas.css">
<img src="img/sims.png?v=2"><script src="https://cdn.example/x.js"></script>
<img src="/etc/passwd"><img src="../../secrets.png"><a href="#top">top</a>
<img src='data:image/png;base64,AAAA'><a href="mailto:brad@example.com">mail</a>`;
    expect(localAssetReferences(html)).toEqual(["canvas.css", "img/sims.png"]);
    const inlined = inlineAssets(
      html,
      new Map([
        ["canvas.css", "data:text/css;base64,Ym9keXt9"],
        ["img/sims.png", "data:image/png;base64,iVBO"],
      ]),
    );
    expect(inlined).toContain('href="data:text/css;base64,Ym9keXt9"');
    expect(inlined).toContain('src="data:image/png;base64,iVBO"');
    expect(inlined).toContain('src="../../secrets.png"');
    expect(inlined).toContain('src="https://cdn.example/x.js"');
  });

  it("knows the asset types a static canvas uses", () => {
    expect(mimeFor("chart.svg")).toBe("image/svg+xml");
    expect(mimeFor("data.JSON")).toBe("application/json");
    expect(mimeFor("binary.exe")).toBeNull();
  });
});

describe("canvas manifest", () => {
  const entry = (overrides: Record<string, string> = {}) => ({
    id: "fork-health",
    title: "Fork health",
    path: "fork-health/index.html",
    size: "full" as const,
    ...overrides,
  });

  it("accepts short unique ids and .html pages inside the canvas folder", () => {
    expect(
      validateManifest([entry(), entry({ id: "funnel", path: "index.html", title: " Funnel " })]),
    ).toEqual({
      entries: [entry(), { id: "funnel", title: "Funnel", path: "index.html", size: "full" }],
    });
  });

  it("rejects ids that cannot be widget ids, duplicates, and paths that leave the folder", () => {
    for (const bad of [
      [entry({ id: "Fork Health" })],
      [entry({ id: "a".repeat(31) })],
      [entry(), entry()],
      [entry({ path: "../secrets.html" })],
      [entry({ path: "/etc/page.html" })],
      [entry({ path: "https://example.com/page.html" })],
      [entry({ path: "notes.txt" })],
      [entry({ title: " " })],
      Array.from({ length: 9 }, (_, index) => entry({ id: `c${index}` })),
    ]) {
      expect(validateManifest(bad)).toHaveProperty("error");
    }
  });
});
