import { describe, expect, it } from "vite-plus/test";

import {
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
});
