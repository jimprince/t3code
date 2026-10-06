import { defaultProjectLayoutTabs, applyLayoutOps, type ProjectLayout } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addWidgetOp,
  dashboardSetOps,
  describeLayout,
  parseLayoutOps,
  parseWidgetIds,
} from "../src/projectLayout.js";

const layout = {
  rootThreadId: "root",
  revision: 3,
  updatedAt: null,
  updatedBy: null,
  tabs: defaultProjectLayoutTabs(null),
} as unknown as ProjectLayout;

const firstTabTypes = (ids: ReadonlyArray<string>) => {
  const result = applyLayoutOps(layout.tabs, dashboardSetOps(layout, ids));
  if ("error" in result) throw new Error(result.error);
  return result.tabs[0]!.widgets.map((widget) => widget.type);
};

describe("dashboard set", () => {
  it("trims, lowercases and de-duplicates the ids", () => {
    expect(parseWidgetIds(" Requests, decisions ,requests,,")).toEqual(["requests", "decisions"]);
  });

  it("accepts widget types that have no older id, alongside older ids", () => {
    expect(
      firstTabTypes(["requests", "decisions", "markdown", "links", "canvas-slot", "roadmap"]),
    ).toEqual(["requests", "decisions", "markdown", "links", "canvas-slot", "roadmap-summary"]);
  });

  it("rejects an unknown id by name instead of dropping it", () => {
    expect(() => dashboardSetOps(layout, ["requests", "decisons", "nope"])).toThrow(
      /Unknown widget ids: decisons, nope\./,
    );
  });
});

describe("dashboard show", () => {
  it("lists every widget of every tab, including types with no older id", () => {
    const shown = describeLayout(layout);
    expect(shown.tabs.map((tab) => tab.title)).toEqual(["Dashboard", "Roadmap", "Tasks"]);
    const dashboard = shown.tabs[0]!.widgets;
    expect(dashboard.map((widget) => widget.type)).toContain("decisions");
    expect(dashboard.find((widget) => widget.type === "requests")).toEqual({
      id: "requests",
      type: "requests",
      size: null,
      config: { includeLater: false },
    });
  });
});

describe("project layout add and apply", () => {
  it("builds one addWidget op for a registered type", () => {
    expect(addWidgetOp("decisions", "dashboard")).toEqual({
      op: "addWidget",
      tabId: "dashboard",
      widget: { type: "decisions" },
    });
  });

  it("rejects an unknown widget type", () => {
    expect(() => addWidgetOp("decisons", "dashboard")).toThrow(/Unknown widget type "decisons"/);
  });

  it("parses --ops and rejects malformed ones", () => {
    expect(
      parseLayoutOps('[{"op":"setWidgetSize","widgetId":"requests","size":"full"}]'),
    ).toHaveLength(1);
    expect(() => parseLayoutOps("{")).toThrow(/not valid JSON/);
    expect(() => parseLayoutOps('{"op":"addTab"}')).toThrow(/must be a JSON array/);
    expect(() => parseLayoutOps('[{"op":"explode"}]')).toThrow(/invalid op/);
  });
});
