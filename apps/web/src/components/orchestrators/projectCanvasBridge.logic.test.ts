import { describe, expect, it } from "vite-plus/test";

import {
  allowedIssueUrl,
  allowedUrl,
  hostsOf,
  parseCanvasMessage,
  RATE_LIMIT,
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
