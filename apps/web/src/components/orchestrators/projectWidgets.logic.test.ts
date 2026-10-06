import { describe, expect, it } from "vite-plus/test";

import {
  canvasWidgetId,
  DEFAULT_WIDGET_ORDER,
  moveChoice,
  savedOrder,
  visibleWidgets,
  widgetChoices,
} from "./projectWidgets.logic";

describe("project widgets", () => {
  it("shows the default order until customized, and drops unknown ids", () => {
    expect(visibleWidgets(null)).toEqual(DEFAULT_WIDGET_ORDER);
    expect(DEFAULT_WIDGET_ORDER.slice(0, 3)).toEqual(["requests", "needs-you", "release"]);
    expect(visibleWidgets(["release", "future-widget", "requests"])).toEqual([
      "release",
      "requests",
    ]);
  });

  it("lists visible widgets first in order, then hidden ones, and saves the visible order", () => {
    const choices = widgetChoices(["release", "requests"]);
    expect(choices.slice(0, 3).map((choice) => [choice.id, choice.visible])).toEqual([
      ["release", true],
      ["requests", true],
      ["needs-you", false],
    ]);
    const moved = moveChoice(choices, 1, -1);
    expect(savedOrder(moved)).toEqual(["requests", "release"]);
    expect(moveChoice(choices, 0, -1)).toEqual(choices);
  });

  const canvases = [
    { id: canvasWidgetId("fork-health"), title: "Fork health" },
    { id: canvasWidgetId("funnel"), title: "Funnel" },
  ];

  it("expands the canvas slot into the manifest canvases unless one is placed on its own", () => {
    const order = visibleWidgets(null, canvases);
    const at = order.indexOf("canvas:fork-health");
    expect(order.slice(at, at + 2)).toEqual(["canvas:fork-health", "canvas:funnel"]);
    expect(order).not.toContain("canvas");
    expect(visibleWidgets(["canvas:funnel", "requests", "canvas"], canvases)).toEqual([
      "canvas:funnel",
      "requests",
      "canvas:fork-health",
    ]);
    // A canvas the manifest dropped disappears; with no canvases the slot stays.
    expect(visibleWidgets(["canvas:gone", "canvas"], [])).toEqual(["canvas"]);
  });

  it("lists canvases one by one in Customize, so hiding one sticks", () => {
    const choices = widgetChoices(null, canvases).map((choice) =>
      choice.id === "canvas:funnel" ? { ...choice, visible: false } : choice,
    );
    expect(choices.some((choice) => choice.id === "canvas")).toBe(false);
    const saved = savedOrder(choices);
    expect(saved).toContain("canvas:fork-health");
    expect(visibleWidgets(saved, canvases)).not.toContain("canvas:funnel");
    expect(widgetChoices(saved, canvases).find((choice) => choice.id === "canvas:funnel")).toEqual({
      id: "canvas:funnel",
      title: "Funnel",
      visible: false,
    });
  });
});
