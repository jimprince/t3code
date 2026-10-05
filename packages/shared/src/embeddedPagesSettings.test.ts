import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyServerSettingsPatch } from "./serverSettings.ts";

const page = (id: string) => ({ id, name: id, url: `https://${id}.example`, icon: "globe" });

describe("embeddedPages settings patch", () => {
  it("replaces the whole list, so removal and reordering persist", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      embeddedPages: [page("a"), page("b"), page("c")],
    });
    const reordered = applyServerSettingsPatch(saved, {
      embeddedPages: [page("c"), page("a")],
    });
    expect(reordered.embeddedPages.map((entry) => entry.id)).toEqual(["c", "a"]);
    expect(applyServerSettingsPatch(reordered, { embeddedPages: [] }).embeddedPages).toEqual([]);
  });
});
