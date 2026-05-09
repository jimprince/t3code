import { describe, expect, it } from "vitest";

import { resolvePendingRequestPanelMaxHeight } from "./threadDetailLayout";

describe("resolvePendingRequestPanelMaxHeight", () => {
  it("caps the pending request panel so the composer still fits on screen", () => {
    expect(
      resolvePendingRequestPanelMaxHeight({
        viewportHeight: 844,
        topInset: 59,
        composerChrome: 68,
        composerBottomInset: 34,
        activeWorkIndicatorHeight: 44,
      }),
    ).toBe(563);
  });

  it("preserves a scrollable minimum height on shorter viewports", () => {
    expect(
      resolvePendingRequestPanelMaxHeight({
        viewportHeight: 520,
        topInset: 59,
        composerChrome: 68,
        composerBottomInset: 34,
        activeWorkIndicatorHeight: 44,
      }),
    ).toBe(239);
  });

  it("never shrinks below the minimum interactive height", () => {
    expect(
      resolvePendingRequestPanelMaxHeight({
        viewportHeight: 420,
        topInset: 59,
        composerChrome: 174,
        composerBottomInset: 34,
        activeWorkIndicatorHeight: 44,
      }),
    ).toBe(180);
  });
});
