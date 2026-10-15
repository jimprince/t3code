import type { DashboardAttention } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { answerPlan, cardSummary, questionsComplete, sendableText } from "./decisionCard.ts";

const attention = (patch: Partial<DashboardAttention>): DashboardAttention => ({
  id: "a",
  taskId: "issue:git/o/r#1",
  requestId: null,
  blockingTaskIds: [],
  title: "Title",
  kind: "review",
  canRespond: false,
  options: [{ text: "Approve and close", recommended: true, action: "approve" }],
  priority: 1,
  url: null,
  threadId: null,
  updatedAt: "2026-10-15T12:00:00.000Z",
  deadline: null,
  question: "",
  sourceId: "s",
  ...patch,
});
const context = { decisionAnswers: true, issueAnswerable: true, told: "Head" };

describe("answerPlan", () => {
  it("gives every issue kind its options plus a typed answer", () => {
    for (const answer of ["issue-choice", "issue-review", "issue-test", "issue-read"] as const) {
      expect(answerPlan(attention({ answer }), context).mode).toBe("issue");
    }
  });

  it("offers Discuss on decisions and reviews but not on a test or an answer to read", () => {
    const discuss = (answer: "issue-review" | "issue-test") => {
      const plan = answerPlan(attention({ answer }), context);
      return plan.mode === "issue" && plan.discuss;
    };
    expect(discuss("issue-review")).toBe(true);
    expect(discuss("issue-test")).toBe(false);
  });

  it("falls back to today's controls on a host without the capability", () => {
    const old = { ...context, decisionAnswers: false };
    expect(answerPlan(attention({ answer: "issue-review" }), old).mode).toBe("open");
    expect(answerPlan(attention({ kind: "decision" }), old).mode).toBe("legacy-option");
    expect(
      answerPlan(attention({ kind: "approval", requestId: "r", canRespond: true }), old).mode,
    ).toBe("approval");
  });

  it("answers a thread question inline only while it can respond and every question is single-select", () => {
    const question = {
      id: "q",
      header: "H",
      question: "Q?",
      options: [{ label: "A", description: "a" }],
    };
    const base = {
      answer: "thread-question" as const,
      kind: "question" as const,
      requestId: "r",
      threadId: "t" as DashboardAttention["threadId"],
      canRespond: true,
      questions: [question],
    };
    expect(answerPlan(attention(base), context).mode).toBe("questions");
    expect(answerPlan(attention({ ...base, canRespond: false }), context).mode).toBe("open");
    expect(
      answerPlan(attention({ ...base, questions: [{ ...question, multiSelect: true }] }), context)
        .mode,
    ).toBe("open");
  });
});

describe("cardSummary", () => {
  it("is the producer's sentence, never the title again", () => {
    expect(cardSummary(attention({ summary: "Widened the column." }))).toBe("Widened the column.");
    expect(cardSummary(attention({ question: "  title " }))).toBeNull();
    expect(cardSummary(attention({ summary: "x", asksNothingYet: true }))).toBeNull();
  });
});

describe("typed answers and multi-question completeness", () => {
  it("refuses an empty or over-long answer", () => {
    expect(sendableText("   ")).toBeNull();
    expect(sendableText("x".repeat(2001))).toBeNull();
    expect(sendableText(" ok ")).toBe("ok");
  });

  it("needs an answer for each required question", () => {
    const q = (id: string, required?: boolean) => ({
      id,
      header: id,
      question: id,
      options: [],
      ...(required === undefined ? {} : { required }),
    });
    expect(questionsComplete([q("a"), q("b", false)], { a: "x" })).toBe(true);
    expect(questionsComplete([q("a"), q("b")], { a: "x", b: " " })).toBe(false);
  });
});
