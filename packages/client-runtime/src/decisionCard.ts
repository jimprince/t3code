import type { DashboardAttention } from "@t3tools/contracts";

import { approvalChoices, type ApprovalChoice } from "./decisionAsk.ts";

export type PlanOption = DashboardAttention["options"][number];
export type PlanQuestion = NonNullable<DashboardAttention["questions"]>[number];

/** What a Dashboard card lets Brad do in place, derived once so web and mobile read it the same way. */
export type AnswerPlan =
  /** An issue item (decision, review, test, answer to read): options plus a typed answer. */
  | {
      readonly mode: "issue";
      readonly options: ReadonlyArray<PlanOption>;
      readonly placeholder: string;
      /** Whether Discuss is offered (a real alternative to answering). */
      readonly discuss: boolean;
    }
  /** A thread's own questions, answered one by one through the existing respond path. */
  | { readonly mode: "questions"; readonly questions: ReadonlyArray<PlanQuestion> }
  /** A live approval request: the provider's choices. */
  | { readonly mode: "approval"; readonly choices: ReadonlyArray<ApprovalChoice> }
  /** Hosts without `decisionAnswers`: today's option buttons on a needs-brad decision. */
  | { readonly mode: "legacy-option"; readonly options: ReadonlyArray<PlanOption> }
  | { readonly mode: "open" };

export interface AnswerContext {
  /** The serving host advertises `capabilities.decisionAnswers`. */
  readonly decisionAnswers: boolean;
  /** The decision is an issue and its project has a head thread to answer through. */
  readonly issueAnswerable: boolean;
  /** Who gets the answer, in words, for the box's placeholder. */
  readonly told: string;
}

function placeholder(answer: NonNullable<DashboardAttention["answer"]>, told: string): string {
  switch (answer) {
    case "issue-review":
      return `Note to send back to ${told}`;
    case "issue-test":
      return `Note for ${told}: what broke, or what you saw`;
    case "issue-read":
      return `Follow-up for ${told}`;
    default:
      return `Your answer to ${told}`;
  }
}

/** Whether a question can be answered inline at all: multi-select ones go through the thread. */
const inlineQuestion = (question: PlanQuestion) => question.multiSelect !== true;

export function answerPlan(attention: DashboardAttention, context: AnswerContext): AnswerPlan {
  const kind = attention.answer;
  if (context.decisionAnswers && kind !== undefined) {
    if (kind === "thread-question") {
      const questions = attention.questions ?? [];
      return attention.canRespond &&
        attention.threadId !== null &&
        attention.requestId !== null &&
        questions.length > 0 &&
        questions.every(inlineQuestion)
        ? { mode: "questions", questions }
        : { mode: "open" };
    }
    if (kind === "thread-approval") {
      return attention.canRespond && attention.threadId !== null && attention.requestId !== null
        ? {
            mode: "approval",
            choices: approvalChoices({ options: attention.approvalOptions ?? [] }),
          }
        : { mode: "open" };
    }
    // An open question has no options: the typed answer is the whole answer.
    if (!context.issueAnswerable) return { mode: "open" };
    return {
      mode: "issue",
      options: attention.options,
      placeholder: placeholder(kind, context.told),
      discuss: kind !== "issue-test" && kind !== "issue-read",
    };
  }
  // Older host, or an older snapshot: exactly the controls these cards had before #355.
  if (
    attention.requestId === null &&
    attention.kind === "decision" &&
    attention.options.length > 0 &&
    context.issueAnswerable
  )
    return { mode: "legacy-option", options: attention.options };
  if (attention.requestId !== null && attention.kind === "approval" && attention.canRespond)
    return { mode: "approval", choices: LEGACY_APPROVAL };
  return { mode: "open" };
}

const LEGACY_APPROVAL: ReadonlyArray<ApprovalChoice> = [
  { decision: "accept", label: "Approve" },
  { decision: "decline", label: "Decline" },
];

/**
 * The line a card shows under its title, never the title again: the producer's one-sentence
 * summary, else the question text, else nothing. `asksNothingYet` items show a flag instead.
 */
export function cardSummary(attention: DashboardAttention): string | null {
  if (attention.asksNothingYet === true) return null;
  const same = (text: string) =>
    text.trim().replace(/\s+/g, " ").toLowerCase() ===
    attention.title.trim().replace(/\s+/g, " ").toLowerCase();
  for (const candidate of [attention.summary, attention.question]) {
    const text = candidate?.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (text && !same(text)) return text;
  }
  return null;
}

/** A multi-question ask is ready to send once every required question has a non-empty answer. */
export function questionsComplete(
  questions: ReadonlyArray<PlanQuestion>,
  answers: Readonly<Record<string, string>>,
): boolean {
  return questions.every(
    (question) => question.required === false || (answers[question.id]?.trim() ?? "") !== "",
  );
}

/** The `answers` payload of respondToUserInput: option value or label, or the typed text. */
export function questionAnswerValues(
  questions: ReadonlyArray<PlanQuestion>,
  picks: Readonly<Record<string, string>>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const given = picks[question.id]?.trim();
    if (given) answers[question.id] = given;
  }
  return answers;
}

/** A typed answer may be sent: non-empty after trimming, within the contract's limit. */
export const TYPED_ANSWER_MAX = 2000;
export const sendableText = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed && trimmed.length <= TYPED_ANSWER_MAX ? trimmed : null;
};
