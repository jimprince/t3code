import { describe, expect, it } from "vite-plus/test";

import {
  decisionAnswerInput,
  decisionSendStrip,
  keptDecisionAnswers,
  type DecisionAnswerRecord,
  type DecisionDelivery,
} from "./decisionAnswer.ts";

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
  it("says the answer is about to go, with Undo, while held", () => {
    expect(decisionSendStrip("held", "Day Planner")).toEqual({
      text: "Sending to Day Planner in a moment",
      undoable: true,
      retryable: false,
    });
  });

  it("says where the answer went, or that only the issue has it", () => {
    expect(decisionSendStrip({ phase: "sending" }, "Day Planner").text).toBe(
      "Sending to Day Planner",
    );
    expect(decisionSendStrip({ phase: "sent", at: 1, notified: true }, "Day Planner").text).toBe(
      "Sent to Day Planner",
    );
    expect(decisionSendStrip({ phase: "sent", at: 1, notified: false }, "Day Planner").text).toBe(
      "Posted on the issue; Day Planner was not found",
    );
  });

  it("shows the server's reason with Retry when sending failed", () => {
    expect(
      decisionSendStrip({ phase: "failed", error: "Gitea API returned HTTP 500." }, "Day Planner"),
    ).toEqual({
      text: "Not sent: Gitea API returned HTTP 500.",
      undoable: false,
      retryable: true,
    });
  });
});

describe("keptDecisionAnswers", () => {
  const answer = (delivery: DecisionDelivery): DecisionAnswerRecord<string> => ({
    issue: "brad/chief-of-staff#14",
    answered: "Answered: Tailnet/LAN only with one password",
    input: { decision: "option", option: "Tailnet/LAN only with one password" },
    delivery,
  });
  const key = "brad/chief-of-staff#14";
  const sentAt = 1_000;

  it("keeps a sent answer while a refetch still lists its issue", () => {
    const answers = new Map([[key, answer({ phase: "sent", at: sentAt, notified: true })]]);
    // A list read before the answer landed, and one read after that the server has not caught up on.
    expect(keptDecisionAnswers(answers, new Set([key]), sentAt - 500)).toBe(answers);
    expect(keptDecisionAnswers(answers, new Set([key]), sentAt + 500)).toBe(answers);
  });

  it("lets a sent answer leave once a list read after it no longer has the issue", () => {
    const answers = new Map([[key, answer({ phase: "sent", at: sentAt, notified: true })]]);
    expect(keptDecisionAnswers(answers, new Set(), sentAt + 500).size).toBe(0);
  });

  it("keeps sending and failed answers whatever the list says", () => {
    const sending = new Map([[key, answer({ phase: "sending" })]]);
    const failed = new Map([[key, answer({ phase: "failed", error: "Thread is archived." })]]);
    expect(keptDecisionAnswers(sending, new Set(), sentAt + 500)).toBe(sending);
    expect(keptDecisionAnswers(failed, new Set(), sentAt + 500)).toBe(failed);
  });
});
