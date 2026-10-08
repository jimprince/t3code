import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyLayoutOps,
  defaultProjectLayoutTabs,
  legacyWidgetOrder,
  normalizeWidgetConfig,
  PROJECT_WIDGET_TYPES,
  ProjectLayout,
  widgetOrderOps,
  withoutRetiredWidgets,
  type ProjectLayoutTab,
} from "./projectLayout.ts";

const ids = (tabs: ReadonlyArray<ProjectLayoutTab>) =>
  tabs.map((tab) => [tab.id, tab.widgets.map((widget) => widget.id)]);

const applied = (
  tabs: ReadonlyArray<ProjectLayoutTab>,
  ops: Parameters<typeof applyLayoutOps>[1],
) => {
  const result = applyLayoutOps(tabs, ops);
  if ("error" in result) throw new Error(result.error);
  return result.tabs;
};

const orderOps = (tabs: ReadonlyArray<ProjectLayoutTab>, order: ReadonlyArray<string>) => {
  const result = widgetOrderOps(tabs, order);
  if ("error" in result) throw new Error(result.error);
  return result.ops;
};

describe("default layout", () => {
  it("is today's page: Dashboard in the default order, Roadmap and Issues", () => {
    const tabs = defaultProjectLayoutTabs(null);
    expect(tabs.map((tab) => tab.title)).toEqual(["Dashboard", "Roadmap", "Tasks"]);
    expect(tabs[0]!.widgets.map((widget) => widget.type)).toEqual([
      "requests",
      "needs-you",
      "decisions",
      "release",
      "maintenance",
      "roadmap-summary",
      "issues-summary",
      "prs",
      "canvas-slot",
      "automations",
    ]);
    expect(tabs[0]!.widgets[0]!.config).toEqual({ includeLater: false });
    expect(tabs[2]!.widgets[0]!.config).toEqual({ pendingPreview: 10 });
  });

  it("migrates a saved widget order, canvases included, and maps back for the CLI", () => {
    const tabs = defaultProjectLayoutTabs(["release", "canvas:fork-health", "roadmap", "gone"]);
    expect(tabs[0]!.widgets.map((widget) => [widget.id, widget.type, widget.config])).toEqual([
      ["release", "release", {}],
      ["canvas-fork-health", "canvas", { canvasId: "fork-health" }],
      ["roadmap-summary", "roadmap-summary", {}],
    ]);
    expect(legacyWidgetOrder(tabs)).toEqual(["release", "canvas:fork-health", "roadmap"]);
  });
});

describe("layout ops", () => {
  const base = defaultProjectLayoutTabs(["requests", "release"]);

  it("adds, renames, moves and removes tabs and widgets by id", () => {
    const tabs = applied(base, [
      { op: "addTab", tab: { title: "Health checks" } },
      {
        op: "addWidget",
        tabId: "health-checks",
        widget: { type: "markdown", config: { text: "Hi" } },
      },
      { op: "moveWidget", widgetId: "release", tabId: "health-checks", index: 0 },
      { op: "renameTab", tabId: "health-checks", title: "Health" },
      { op: "moveTab", tabId: "health-checks", index: 1 },
      { op: "removeTab", tabId: "issues" },
    ]);
    expect(ids(tabs)).toEqual([
      ["dashboard", ["requests"]],
      ["health-checks", ["release", "markdown"]],
      ["roadmap", ["roadmap-board"]],
    ]);
    expect(tabs[1]!.title).toBe("Health");
  });

  it("merges settings, retitles and resizes a widget, and checks its settings", () => {
    const tabs = applied(base, [
      { op: "setWidgetConfig", widgetId: "requests", config: { includeLater: true } },
      { op: "setWidgetTitle", widgetId: "requests", title: "Asks" },
      { op: "setWidgetSize", widgetId: "requests", size: "medium" },
    ]);
    expect(tabs[0]!.widgets[0]).toEqual({
      id: "requests",
      type: "requests",
      title: "Asks",
      size: "medium",
      config: { includeLater: true },
    });
    expect(
      applyLayoutOps(base, [
        { op: "setWidgetConfig", widgetId: "requests", config: { includeLater: "yes" } },
      ]),
    ).toHaveProperty("error");
    expect(
      applyLayoutOps(base, [
        { op: "setWidgetConfig", widgetId: "issues-board", config: { pendingPreview: 0 } },
      ]),
    ).toHaveProperty("error");
  });

  it("fails the whole batch when a target is gone or a rule breaks", () => {
    expect(applyLayoutOps(base, [{ op: "removeWidget", widgetId: "nope" }])).toHaveProperty(
      "error",
    );
    expect(
      applyLayoutOps(base, [{ op: "addWidget", tabId: "dashboard", widget: { type: "chart" } }]),
    ).toHaveProperty("error");
    expect(
      applyLayoutOps(base, [{ op: "addWidget", tabId: "dashboard", widget: { type: "canvas" } }]),
    ).toHaveProperty("error");
    const oneTab = applied(base, [
      { op: "removeTab", tabId: "roadmap" },
      { op: "removeTab", tabId: "issues" },
    ]);
    expect(applyLayoutOps(oneTab, [{ op: "removeTab", tabId: "dashboard" }])).toHaveProperty(
      "error",
    );
    expect(
      applyLayoutOps(base, [
        {
          op: "addWidget",
          tabId: "dashboard",
          widget: {
            type: "links",
            config: { items: [{ label: "x", url: "javascript:alert(1)" }] },
          },
        },
      ]),
    ).toHaveProperty("error");
  });

  it("gives new widgets unique ids and replaces a whole layout", () => {
    const tabs = applied(base, [
      { op: "addWidget", tabId: "dashboard", widget: { type: "requests" } },
      {
        op: "addWidget",
        tabId: "dashboard",
        widget: { type: "canvas", config: { canvasId: "funnel" } },
      },
    ]);
    expect(tabs[0]!.widgets.map((widget) => widget.id)).toEqual([
      "requests",
      "release",
      "requests-2",
      "canvas-funnel",
    ]);
    const replaced = applied(base, [
      { op: "replaceLayout", tabs: [{ title: "Only", widgets: [{ type: "needs-you" }] }] },
    ]);
    expect(ids(replaced)).toEqual([["only", ["needs-you"]]]);
  });

  it("sets the first tab from the CLI's widget order, keeping widget ids and settings", () => {
    const configured = applied(base, [
      { op: "setWidgetConfig", widgetId: "requests", config: { includeLater: true } },
    ]);
    const tabs = applied(configured, orderOps(configured, ["release", "requests", "prs"]));
    expect(tabs[0]!.widgets.map((widget) => [widget.id, widget.config])).toEqual([
      ["release", {}],
      ["requests", { includeLater: true }],
      ["prs", {}],
    ]);
  });

  it("accepts every registered widget type and older ids in the CLI's widget order", () => {
    const tabs = applied(
      base,
      orderOps(base, ["decisions", "markdown", "links", "canvas-slot", "roadmap", "canvas:funnel"]),
    );
    expect(tabs[0]!.widgets.map((widget) => widget.type)).toEqual([
      "decisions",
      "markdown",
      "links",
      "canvas-slot",
      "roadmap-summary",
      "canvas",
    ]);
  });

  it("rejects ids that name no widget instead of dropping them", () => {
    const result = widgetOrderOps(base, ["requests", "decisons", "nope"]);
    expect(result).toEqual({
      error: expect.stringContaining("Unknown widget ids: decisons, nope."),
    });
  });
});

describe("widget settings", () => {
  it("fills defaults and drops unknown keys", () => {
    expect(normalizeWidgetConfig("issues-board", { other: 1 })).toEqual({
      config: { pendingPreview: 10 },
    });
    expect(normalizeWidgetConfig("unknown", {})).toHaveProperty("error");
  });
});

describe("retired widgets", () => {
  const retired = ["working", "blocked", "done"];

  it("are no longer offered or accepted as new widgets", () => {
    const offered = PROJECT_WIDGET_TYPES.map((entry) => entry.type);
    for (const type of retired) expect(offered).not.toContain(type);
    const result = applyLayoutOps(defaultProjectLayoutTabs(null), [
      { op: "addWidget", tabId: "dashboard", widget: { type: "working" } },
    ]);
    expect("error" in result).toBe(true);
  });

  it("load from an old saved layout, which renders the rest and stays editable", () => {
    // A revision as saved before the widgets were retired.
    const saved = Schema.decodeUnknownSync(ProjectLayout)({
      rootThreadId: "root",
      revision: 4,
      updatedAt: "2026-10-05T00:00:00.000Z",
      updatedBy: null,
      tabs: [
        {
          id: "dashboard",
          title: "Dashboard",
          widgets: [
            { id: "requests", type: "requests", config: { includeLater: false } },
            { id: "working", type: "working", config: {} },
            { id: "blocked", type: "blocked", config: {} },
            { id: "release", type: "release", config: {} },
            { id: "done", type: "done", config: {} },
          ],
        },
        { id: "extra", title: "Extra", widgets: [{ id: "done-2", type: "done", config: {} }] },
      ],
    });
    const tabs = withoutRetiredWidgets(saved.tabs);
    expect(ids(tabs)).toEqual([
      ["dashboard", ["requests", "release"]],
      ["extra", []],
    ]);
    // Editing the cleaned layout works, and saving it persists the cleanup.
    const edited = applied(tabs, [
      { op: "moveWidget", widgetId: "release", tabId: "dashboard", index: 0 },
    ]);
    expect(ids(edited)[0]).toEqual(["dashboard", ["release", "requests"]]);
  });

  it("leave a layout without them untouched, by identity", () => {
    const tabs = defaultProjectLayoutTabs(null);
    expect(withoutRetiredWidgets(tabs)).toBe(tabs);
  });

  it("drop out of an older saved widget order and out of `dashboard set` without an error", () => {
    const migrated = defaultProjectLayoutTabs(["release", "working", "blocked", "done", "roadmap"]);
    expect(migrated[0]!.widgets.map((widget) => widget.type)).toEqual([
      "release",
      "roadmap-summary",
    ]);
    const ops = orderOps(migrated, ["working", "release", "done"]);
    expect(ops.flatMap((op) => (op.op === "addWidget" ? [op.widget.type] : []))).toEqual([
      "release",
    ]);
    expect(widgetOrderOps(migrated, ["releas"])).toMatchObject({
      error: expect.stringContaining("Unknown"),
    });
  });
});
