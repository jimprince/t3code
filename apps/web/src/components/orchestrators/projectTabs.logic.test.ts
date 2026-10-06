import { describe, expect, it } from "vite-plus/test";

import { isProjectTab, resolveProjectTab } from "./projectTabs.logic";

describe("project tabs", () => {
  it("prefers the URL, then the remembered tab, then the dashboard", () => {
    expect(resolveProjectTab("issues", "roadmap")).toBe("issues");
    expect(resolveProjectTab(null, "roadmap")).toBe("roadmap");
    expect(resolveProjectTab(null, "bogus")).toBe("dashboard");
    expect(isProjectTab("roadmap")).toBe(true);
    expect(isProjectTab(undefined)).toBe(false);
  });
});
