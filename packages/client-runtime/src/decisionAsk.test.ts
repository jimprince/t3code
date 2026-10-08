import type { ProjectPendingAsk } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { approvalChoices, approvalTitle, oneTapQuestion, questionAnswers } from "./decisionAsk.ts";

type QuestionAsk = Extract<ProjectPendingAsk, { kind: "question" }>;

const question = (extra: Partial<QuestionAsk["questions"][number]> = {}) => ({
  id: "heard",
  header: "Timer",
  question: "Did the timer stop?",
  options: [
    { label: "Yes", description: "Stopped" },
    { label: "No", description: "Still ringing", value: "no-ring" },
  ],
  ...extra,
});

const ask = (extra: Partial<QuestionAsk> = {}): QuestionAsk => ({
  kind: "question",
  threadId: "t" as never,
  threadTitle: "Printer Voice",
  projectTitle: "Home Assistant",
  requestId: "r" as never,
  createdAt: "2026-10-08T00:00:00.000Z",
  canRespond: true,
  questions: [question()],
  messageResponse: false,
  ...extra,
});

describe("oneTapQuestion", () => {
  it("takes a live single-select question", () => {
    expect(oneTapQuestion(ask())?.id).toBe("heard");
  });

  it("leaves several questions, multi-select, message replies and stale requests to the thread", () => {
    expect(oneTapQuestion(ask({ questions: [question(), question({ id: "b" })] }))).toBeNull();
    expect(oneTapQuestion(ask({ questions: [question({ multiSelect: true })] }))).toBeNull();
    expect(oneTapQuestion(ask({ messageResponse: true }))).toBeNull();
    expect(oneTapQuestion(ask({ canRespond: false }))).toBeNull();
    expect(oneTapQuestion(ask({ questions: [] }))).toBeNull();
  });
});

describe("questionAnswers", () => {
  it("answers with the option's value, else its label", () => {
    expect(questionAnswers(question(), { kind: "option", index: 0 })).toEqual({ heard: "Yes" });
    expect(questionAnswers(question(), { kind: "option", index: 1 })).toEqual({ heard: "no-ring" });
    expect(questionAnswers(question(), { kind: "option", index: 5 })).toBeNull();
  });

  it("answers Other with the typed text unless the question takes no custom answer", () => {
    expect(questionAnswers(question(), { kind: "other", text: "  not near it " })).toEqual({
      heard: "not near it",
    });
    expect(questionAnswers(question(), { kind: "other", text: "  " })).toBeNull();
    expect(
      questionAnswers(question({ allowCustomAnswer: false }), { kind: "other", text: "x" }),
    ).toBeNull();
  });
});

describe("approvalChoices", () => {
  it("offers Allow once, Allow for this session and Decline by default", () => {
    expect(approvalChoices({}).map((choice) => choice.decision)).toEqual([
      "accept",
      "acceptForSession",
      "decline",
    ]);
  });

  it("uses the provider's options, without Cancel, keeping their warnings", () => {
    const choices = approvalChoices({
      options: [
        { decision: "accept", label: "Approve", warning: "Untrusted app" },
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Deny" },
      ],
    });
    expect(choices).toEqual([
      { decision: "accept", label: "Approve", warning: "Untrusted app" },
      { decision: "decline", label: "Deny", warning: undefined },
    ]);
  });
});

describe("approvalTitle", () => {
  const ask = (extra: object) =>
    ({
      requestKind: "command",
      requestId: "r1",
      threadTitle: "Tool changer worker",
      ...extra,
    }) as never;

  it("names what is asked instead of repeating the command", () => {
    expect(approvalTitle(ask({}))).toBe("Run a command");
    expect(approvalTitle(ask({ requestKind: "file-change" }))).toBe("Change files");
    expect(approvalTitle(ask({ requestKind: "mcp-elicitation", appName: "Linear" }))).toBe(
      "Let Linear continue",
    );
  });

  it("falls back to the thread when the request's text did not arrive", () => {
    expect(approvalTitle(ask({ requestId: "pending" }))).toBe("Tool changer worker needs approval");
  });
});
