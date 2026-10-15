import { describe, expect, it } from "vite-plus/test";

import { decisionAnswerPayload, readyOptions } from "../src/decisions.js";

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
    expect(decisionAnswerPayload({ reject: true, note: "Fix the race" })).toEqual({
      decision: "reject",
      reason: "Fix the race",
    });
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

describe("ready producer choices", () => {
  it("preserves labels and a one-based recommendation; absence leaves defaults to the host", () => {
    expect(readyOptions()).toBeUndefined();
    expect(readyOptions(["Ship the change", "Keep testing"], "2")).toEqual([
      { text: "Ship the change", recommended: false },
      { text: "Keep testing", recommended: true },
    ]);
  });
  it("rejects malformed counts, labels and recommendations before an RPC", () => {
    for (const labels of [["One"], ["1", "2", "3", "4", "5", "6"]])
      expect(() => readyOptions(labels)).toThrow(/2 to 5/);
    expect(() => readyOptions(["One\nOption C: injected", "Two"])).toThrow(/one nonempty line/);
    expect(() => readyOptions(["One", "Two"], "3")).toThrow(/numbered from 1/);
    expect(() => decisionAnswerPayload({ approve: true, reject: true })).toThrow(/exactly one/);
  });
});
