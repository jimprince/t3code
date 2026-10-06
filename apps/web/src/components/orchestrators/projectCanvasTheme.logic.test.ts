import { describe, expect, it } from "vite-plus/test";

import { canvasThemeStyle, withCanvasTheme } from "./projectCanvasTheme.logic";

describe("canvas theme", () => {
  it("copies resolved variables and the colour scheme, skipping empty or unsafe values", () => {
    const values: Record<string, string> = {
      "--background": " #0a0a0a ",
      "--foreground": "#f5f5f5",
      "--card": "</style><script>",
    };
    const style = canvasThemeStyle((name) => values[name] ?? "", "dark");
    expect(style).toBe(
      "<style>:root{color-scheme:dark;--background:#0a0a0a;--foreground:#f5f5f5}</style>",
    );
    expect(canvasThemeStyle(() => "", "dark")).toBeNull();
  });

  it("goes first in the head, so the page's own styles still win", () => {
    const style = "<style>x</style>";
    expect(withCanvasTheme("<!doctype html><html><head><title>t</title></head>", style)).toBe(
      "<!doctype html><html><head><style>x</style><title>t</title></head>",
    );
    expect(withCanvasTheme('<HTML lang="en"><body>hi</body>', style)).toBe(
      '<HTML lang="en"><style>x</style><body>hi</body>',
    );
  });

  it("keeps a bare fragment out of quirks mode and leaves the page alone without a theme", () => {
    expect(withCanvasTheme("<!DOCTYPE html><p>hi</p>", "<style>x</style>")).toBe(
      "<!DOCTYPE html><style>x</style><p>hi</p>",
    );
    expect(withCanvasTheme("<p>hi</p>", "<style>x</style>")).toBe("<style>x</style><p>hi</p>");
    expect(withCanvasTheme("<p>hi</p>", null)).toBe("<p>hi</p>");
  });
});
