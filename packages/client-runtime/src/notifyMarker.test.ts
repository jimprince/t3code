import { describe, expect, it } from "vite-plus/test";
import { notificationDispositionForReply } from "./notificationEligibility.ts";
import { stripNotifyMarker } from "./notifyMarker.ts";

describe("stripNotifyMarker", () => {
  it.each([
    ["Done.\nT3_NOTIFY: attention", "Done."],
    ["Done.\nT3_NOTIFY: quiet", "Done."],
    ["Done.\n\nT3_NOTIFY: quiet\n", "Done."],
    ["Done.\r\nT3_NOTIFY: attention\r\n", "Done."],
    ["Done.\nT3_NOTIFY:   quiet   ", "Done."],
    ["Line one\nLine two\nT3_NOTIFY: attention", "Line one\nLine two"],
  ])("drops the trailing marker line of %j", (text, expected) => {
    expect(stripNotifyMarker(text)).toBe(expected);
  });

  it("returns an empty string for a marker-only message", () => {
    expect(stripNotifyMarker("T3_NOTIFY: quiet")).toBe("");
    expect(stripNotifyMarker("\nT3_NOTIFY: attention\n")).toBe("");
  });

  it.each([
    "Nothing to strip.",
    "",
    "T3_NOTIFY: quiet\nMore work",
    "Before T3_NOTIFY: quiet after",
    "The line `T3_NOTIFY: quiet` routes notifications.",
    "Done.\n  T3_NOTIFY: quiet",
    "Done.\nt3_notify: quiet",
    "Done.\nT3_NOTIFY: loud",
  ])("leaves %j untouched", (text) => {
    expect(stripNotifyMarker(text)).toBe(text);
  });

  it("keeps a marker the author put in a code block", () => {
    const closed = "Use it like this:\n```\nT3_NOTIFY: quiet\n```";
    expect(stripNotifyMarker(closed)).toBe(closed);
    const unclosed = "Use it like this:\n```text\nT3_NOTIFY: attention";
    expect(stripNotifyMarker(unclosed)).toBe(unclosed);
    const tilde = "Example:\n~~~\nT3_NOTIFY: quiet";
    expect(stripNotifyMarker(tilde)).toBe(tilde);
  });

  it("still drops the marker after a closed code block", () => {
    expect(stripNotifyMarker("```\ncode\n```\nDone.\nT3_NOTIFY: quiet")).toBe(
      "```\ncode\n```\nDone.",
    );
  });

  describe("while streaming", () => {
    const streaming = { streaming: true };

    it("hides a marker arriving character by character", () => {
      const full = "Done.\nT3_NOTIFY: attention";
      for (let length = "Done.\n".length + 2; length <= full.length; length += 1) {
        expect(stripNotifyMarker(full.slice(0, length), streaming)).toBe("Done.");
      }
    });

    it("leaves ordinary text and short prefixes alone", () => {
      expect(stripNotifyMarker("Done.\nT", streaming)).toBe("Done.\nT");
      expect(stripNotifyMarker("Done.\nT3 Code is up", streaming)).toBe("Done.\nT3 Code is up");
      expect(stripNotifyMarker("Done.\nT3_NOTIFY: quiet more", streaming)).toBe(
        "Done.\nT3_NOTIFY: quiet more",
      );
    });

    it("does not hide a partial marker inside an open code block", () => {
      const text = "```text\nT3_NOTI";
      expect(stripNotifyMarker(text, streaming)).toBe(text);
    });

    it("does not hide a partial marker unless streaming", () => {
      expect(stripNotifyMarker("Done.\nT3_NOTI")).toBe("Done.\nT3_NOTI");
    });
  });

  it("is a pure display transform: the stored text keeps its routing disposition", () => {
    const stored = "Done.\nT3_NOTIFY: attention";
    expect(stripNotifyMarker(stored)).toBe("Done.");
    expect(notificationDispositionForReply(stored)).toBe("attention");
    expect(notificationDispositionForReply("Done.\nT3_NOTIFY: quiet")).toBe("quiet");
  });
});
