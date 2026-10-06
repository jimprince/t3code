import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { collapsedWidgetsKey, toggleCollapsed } from "./projectWidgetCollapse.logic";

describe("widget collapse memory", () => {
  it("toggles one widget without touching the others", () => {
    expect(toggleCollapsed(["brief"], "needs-you")).toEqual(["brief", "needs-you"]);
    expect(toggleCollapsed(["brief", "needs-you"], "brief")).toEqual(["needs-you"]);
    expect(toggleCollapsed([], "brief")).toEqual(["brief"]);
  });

  it("keeps a separate list for each project page", () => {
    const env = EnvironmentId.make("env-1");
    expect(collapsedWidgetsKey(env, "root-1")).not.toBe(collapsedWidgetsKey(env, "root-2"));
    expect(collapsedWidgetsKey(env, "root-1")).not.toBe(
      collapsedWidgetsKey(EnvironmentId.make("env-2"), "root-1"),
    );
  });
});
