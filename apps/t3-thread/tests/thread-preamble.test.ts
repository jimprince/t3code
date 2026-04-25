import { describe, expect, it } from "vitest";

import { THREAD_PREAMBLE, wrapWithPreamble } from "../src/thread-preamble.js";

describe("thread-preamble", () => {
  describe("THREAD_PREAMBLE constant", () => {
    it("REGRESSION: names the worker a T3 worker thread so the child orients correctly", () => {
      expect(THREAD_PREAMBLE).toContain("T3 worker thread");
    });

    it("REGRESSION: points at the canonical skill path, not an embedded copy", () => {
      // The whole point of a pointer preamble is that updates to the skill
      // file propagate automatically. If this path ever drifts, every
      // worker loses its orientation doc silently.
      expect(THREAD_PREAMBLE).toContain("~/.shared/skills/t3-threads/SKILL.md");
    });

    it("REGRESSION: tells the child how to reach the parent", () => {
      expect(THREAD_PREAMBLE).toContain("t3-agent agent send");
    });
  });

  describe("wrapWithPreamble", () => {
    it("REGRESSION: includes both the preamble and the caller's brief", () => {
      const brief = "Investigate flaky test in monitor.test.ts.";
      const wrapped = wrapWithPreamble(brief);

      expect(wrapped).toContain(THREAD_PREAMBLE);
      expect(wrapped).toContain(brief);
    });

    it("REGRESSION: preamble comes before the brief so the child reads orientation first", () => {
      const brief = "UNIQUE_BRIEF_MARKER_42";
      const wrapped = wrapWithPreamble(brief);

      const preambleIndex = wrapped.indexOf("T3 worker thread");
      const briefIndex = wrapped.indexOf(brief);

      expect(preambleIndex).toBeGreaterThanOrEqual(0);
      expect(briefIndex).toBeGreaterThan(preambleIndex);
    });

    it("does not mangle multi-line briefs", () => {
      const brief = "Line 1\nLine 2\nLine 3";
      const wrapped = wrapWithPreamble(brief);
      expect(wrapped).toContain(brief);
    });
  });
});
