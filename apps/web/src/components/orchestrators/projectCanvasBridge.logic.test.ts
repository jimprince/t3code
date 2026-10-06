import { describe, expect, it } from "vite-plus/test";

import {
  allowedIssueUrl,
  allowedUrl,
  CANVAS_HEIGHT,
  canvasHeightKey,
  clampCanvasHeight,
  hostsOf,
  parseCanvasMessage,
  RATE_LIMIT,
  readStoredCanvasHeight,
  RESIZE_RATE_LIMIT,
  takeRateSlot,
} from "./projectCanvasBridge.logic";

const hosts = hostsOf(["https://git.example/brad/t3code-fork/issues/1", "https://github.com/x/y"]);

describe("canvas messages", () => {
  it("ignores messages that are not canvas messages", () => {
    expect(parseCanvasMessage("hello")).toBeNull();
    expect(parseCanvasMessage({ type: "other", intent: "send" })).toBeNull();
  });

  it("reads the whitelisted intents and refuses everything else", () => {
    expect(
      parseCanvasMessage({ type: "t3-canvas", id: "a", intent: "send", text: " Advance #4 " }),
    ).toEqual({ ok: true, id: "a", action: { intent: "send", text: "Advance #4" } });
    expect(
      parseCanvasMessage({ type: "t3-canvas", intent: "open-thread", threadId: "t1" }),
    ).toEqual({ ok: true, id: null, action: { intent: "open-thread", threadId: "t1" } });
    expect(parseCanvasMessage({ type: "t3-canvas", intent: "eval", code: "x" })).toMatchObject({
      ok: false,
      reason: "unknown intent",
    });
    expect(
      parseCanvasMessage({ type: "t3-canvas", intent: "send", text: "x".repeat(4_001) }),
    ).toMatchObject({ ok: false });
    expect(parseCanvasMessage({ type: "t3-canvas", intent: "send", text: 7 })).toMatchObject({
      ok: false,
    });
  });
});

describe("canvas URLs", () => {
  it("opens only http(s) URLs on known hosts", () => {
    expect(allowedUrl("https://github.com/x/y/pull/2", hosts)).toBe(
      "https://github.com/x/y/pull/2",
    );
    expect(allowedUrl("https://evil.example/", hosts)).toBeNull();
    expect(allowedUrl("javascript:alert(1)", hosts)).toBeNull();
    expect(allowedUrl("https://user:pw@github.com/", hosts)).toBeNull();
    expect(allowedUrl("not a url", hosts)).toBeNull();
  });

  it("treats open-issue as an issue page on a known host", () => {
    expect(allowedIssueUrl("https://git.example/brad/t3code-fork/issues/12", hosts)).not.toBeNull();
    expect(allowedIssueUrl("https://git.example/brad/t3code-fork/settings", hosts)).toBeNull();
  });
});

describe("canvas rate limit", () => {
  it("allows a burst, then waits for the window to pass", () => {
    const history: number[] = [];
    for (let index = 0; index < RATE_LIMIT.count; index++) {
      expect(takeRateSlot(history, 1_000 + index)).toBe(true);
    }
    expect(takeRateSlot(history, 1_100)).toBe(false);
    expect(takeRateSlot(history, 1_000 + RATE_LIMIT.windowMs)).toBe(true);
  });
});

describe("canvas resize", () => {
  const resize = (height: unknown) =>
    parseCanvasMessage({ type: "t3-canvas", intent: "resize", height });

  it("reads a height as a whole number of pixels", () => {
    expect(resize(120)).toEqual({ ok: true, id: null, action: { intent: "resize", height: 120 } });
    expect(resize(120.6)).toMatchObject({ ok: true, action: { height: 121 } });
  });

  it("clamps to the allowed range", () => {
    expect(resize(0)).toMatchObject({ ok: true, action: { height: CANVAS_HEIGHT.min } });
    expect(resize(-50)).toMatchObject({ ok: true, action: { height: CANVAS_HEIGHT.min } });
    expect(resize(5_000)).toMatchObject({ ok: true, action: { height: CANVAS_HEIGHT.max } });
    expect(clampCanvasHeight(41.4)).toBe(41);
  });

  it("refuses a height that is not a finite number", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, "300", null, undefined, {}, [300]]) {
      expect(resize(bad)).toMatchObject({ ok: false, intent: "resize" });
    }
  });
});

describe("canvas resize rate limit", () => {
  it("allows more than the action limit, then waits for the window", () => {
    expect(RESIZE_RATE_LIMIT.count).toBeGreaterThan(RATE_LIMIT.count);
    const history: number[] = [];
    for (let index = 0; index < RESIZE_RATE_LIMIT.count; index++) {
      expect(takeRateSlot(history, 1_000 + index, RESIZE_RATE_LIMIT)).toBe(true);
    }
    expect(takeRateSlot(history, 1_100, RESIZE_RATE_LIMIT)).toBe(false);
    expect(takeRateSlot(history, 1_000 + RESIZE_RATE_LIMIT.windowMs, RESIZE_RATE_LIMIT)).toBe(true);
  });

  it("keeps its own history, so resizes never use up the action budget", () => {
    const actions: number[] = [];
    const resizes: number[] = [];
    for (let index = 0; index < RESIZE_RATE_LIMIT.count; index++) {
      takeRateSlot(resizes, 1_000, RESIZE_RATE_LIMIT);
    }
    expect(takeRateSlot(actions, 1_000)).toBe(true);
  });
});

describe("canvas height storage", () => {
  it("keys the height by environment, project root thread and canvas", () => {
    expect(canvasHeightKey("env-1", "thread-1", "minutes")).toBe(
      "t3code:canvas-height:env-1:thread-1:minutes",
    );
  });

  it("restores a stored height and ignores anything else", () => {
    expect(readStoredCanvasHeight("40")).toBe(40);
    expect(readStoredCanvasHeight("600")).toBe(600);
    expect(readStoredCanvasHeight(null)).toBeNull();
    expect(readStoredCanvasHeight("39")).toBeNull();
    expect(readStoredCanvasHeight("601")).toBeNull();
    expect(readStoredCanvasHeight("120.5")).toBeNull();
    expect(readStoredCanvasHeight("tall")).toBeNull();
    expect(readStoredCanvasHeight("")).toBeNull();
  });
});
