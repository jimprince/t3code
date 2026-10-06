import { describe, expect, it } from "vite-plus/test";

import { decisionAnswerInput, decisionSendStrip, waitingLabel } from "./decisionAnswer.ts";

describe("decisionAnswerInput", () => {
  it("sends a listed option as a choice", () => {
    expect(decisionAnswerInput({ kind: "option", option: "Ship it" }, "")).toEqual({
      decision: "option",
      option: "Ship it",
    });
  });

  it("sends Other and an open question as an answer", () => {
    expect(decisionAnswerInput({ kind: "other", text: "Neither, wait" }, "")).toEqual({
      decision: "answer",
      answer: "Neither, wait",
    });
    expect(decisionAnswerInput({ kind: "open", text: "Tuesday" }, "")).toEqual({
      decision: "answer",
      answer: "Tuesday",
    });
  });

  it("carries a trimmed note and drops a blank one", () => {
    expect(decisionAnswerInput({ kind: "option", option: "A" }, "  after the release  ")).toEqual({
      decision: "option",
      option: "A",
      reason: "after the release",
    });
    expect(decisionAnswerInput({ kind: "option", option: "A" }, "   ")).not.toHaveProperty(
      "reason",
    );
  });

  it("trims the answer and refuses an empty Other", () => {
    expect(decisionAnswerInput({ kind: "other", text: "  later  " }, "")).toMatchObject({
      answer: "later",
    });
    expect(decisionAnswerInput({ kind: "other", text: "   " }, "note")).toBeNull();
    expect(decisionAnswerInput({ kind: "open", text: "" }, "")).toBeNull();
  });
});

describe("decisionSendStrip", () => {
  it("names the waiting thread with Undo while held", () => {
    expect(decisionSendStrip("held", "chief-of-staff-inbox")).toEqual({
      text: "Sent to chief-of-staff-inbox",
      undoable: true,
    });
  });

  it("reads Sending while in flight", () => {
    expect(decisionSendStrip("sending", "chief-of-staff-inbox")).toEqual({
      text: "Sending",
      undoable: false,
    });
  });

  it("reads plain Sent once the hold ends", () => {
    expect(decisionSendStrip("sent", "chief-of-staff-inbox")).toEqual({
      text: "Sent",
      undoable: false,
    });
  });
});

describe("waitingLabel", () => {
  const threads = [
    { id: "0ca91f5c-68af-487e-a07a-2be372d0bf52", title: "End Effector Orchestrator" },
  ];

  it("names the waiting thread, keeps an agent name, and never shows a raw id", () => {
    expect(waitingLabel("0ca91f5c-68af-487e-a07a-2be372d0bf52", threads)).toBe(
      "End Effector Orchestrator",
    );
    expect(waitingLabel("chief-of-staff-inbox", threads)).toBe("chief-of-staff-inbox");
    expect(waitingLabel("11111111-2222-3333-4444-555555555555", threads)).toBe("the orchestrator");
  });
});
