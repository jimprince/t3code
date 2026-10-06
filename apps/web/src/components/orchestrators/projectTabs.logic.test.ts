import { describe, expect, it } from "vite-plus/test";

import { isProjectTab, resolveProjectTab } from "./projectTabs.logic";

describe("project tabs", () => {
  const tabs = ["dashboard", "roadmap", "health"];

  it("prefers the URL, then the remembered tab, then the layout's first tab", () => {
    expect(resolveProjectTab("health", "roadmap", tabs)).toBe("health");
    expect(resolveProjectTab(null, "roadmap", tabs)).toBe("roadmap");
    expect(resolveProjectTab("gone", "bogus", tabs)).toBe("dashboard");
    expect(resolveProjectTab(null, null, ["only"])).toBe("only");
  });

  it("accepts any tab id shape in the URL", () => {
    expect(isProjectTab("health-checks")).toBe(true);
    expect(isProjectTab("Bad Id")).toBe(false);
    expect(isProjectTab(undefined)).toBe(false);
  });
});
