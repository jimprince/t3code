import { describe, expect, it } from "vite-plus/test";

import { decisionAnswerPayload } from "../src/decisions.js";

describe("decision answer flags", () => {
  it("sends the same decide payload the Decisions widget sends", () => {
    expect(
      decisionAnswerPayload({ option: "Spring pins to flat pads", note: " Cheapest " }),
    ).toEqual({ decision: "option", option: "Spring pins to flat pads", reason: "Cheapest" });
    expect(decisionAnswerPayload({ answer: "Use the plug-in connector" })).toEqual({
      decision: "answer",
      answer: "Use the plug-in connector",
    });
    expect(decisionAnswerPayload({ approve: true })).toEqual({ decision: "approve" });
    expect(decisionAnswerPayload({ notYet: true, note: "after the scale test" })).toEqual({
      decision: "not-yet",
      reason: "after the scale test",
    });
  });

  it("refuses anything but exactly one answer", () => {
    expect(() => decisionAnswerPayload({})).toThrow(/exactly one/);
    expect(() => decisionAnswerPayload({ option: "A", approve: true })).toThrow(/exactly one/);
    expect(() => decisionAnswerPayload({ option: "  " })).toThrow(/option's text/);
  });
});
