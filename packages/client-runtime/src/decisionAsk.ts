import type { ProjectPendingAsk, ProviderApprovalDecision } from "@t3tools/contracts";

type QuestionAsk = Extract<ProjectPendingAsk, { kind: "question" }>;
type ApprovalAsk = Extract<ProjectPendingAsk, { kind: "approval" }>;

/** One button of an approval card. */
export interface ApprovalChoice {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  /** The provider's caution shown with the option, such as a prompt-injection warning. */
  readonly warning?: string | undefined;
}

const DEFAULT_CHOICES: ReadonlyArray<ApprovalChoice> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "decline", label: "Decline" },
];

/** The approval's buttons: the provider's own options, else Allow once / for this session / Decline. */
export function approvalChoices(ask: Pick<ApprovalAsk, "options">): ReadonlyArray<ApprovalChoice> {
  const options = ask.options ?? [];
  return options.length === 0
    ? DEFAULT_CHOICES
    : options
        .filter((option) => option.decision !== "cancel")
        .map((option) => ({
          decision: option.decision,
          label: option.label,
          warning: option.warning,
        }));
}

/**
 * What an approval asks, in a few words, so the card's title does not repeat the command it
 * shows below. A request whose text did not arrive reads as the thread needing approval.
 */
export function approvalTitle(
  ask: Pick<ApprovalAsk, "requestKind" | "appName" | "requestId" | "threadTitle">,
): string {
  if (ask.requestId === "pending") return `${ask.threadTitle} needs approval`;
  switch (ask.requestKind) {
    case "command":
      return "Run a command";
    case "file-read":
      return "Read files";
    case "file-change":
      return "Change files";
    case "permission":
      return "Grant a permission";
    case "mcp-elicitation":
      return ask.appName ? `Let ${ask.appName} continue` : "Answer a tool request";
  }
}

/**
 * The one question a card can take a one-tap answer for: a live request with a single
 * single-select question. Anything else (several questions, multi-select, a thread that
 * wants a message instead, a request that outlived its session) is answered in the thread.
 */
export function oneTapQuestion(ask: QuestionAsk): QuestionAsk["questions"][number] | null {
  const [question, ...more] = ask.questions;
  if (!ask.canRespond || ask.messageResponse || question === undefined || more.length > 0) {
    return null;
  }
  return question.multiSelect === true ? null : question;
}

/** The `answers` of `respondToUserInput` for a pick on a one-question card. */
export function questionAnswers(
  question: QuestionAsk["questions"][number],
  pick:
    | { readonly kind: "option"; readonly index: number }
    | { readonly kind: "other"; readonly text: string },
): Record<string, string> | null {
  if (pick.kind === "option") {
    const option = question.options[pick.index];
    return option === undefined ? null : { [question.id]: option.value ?? option.label };
  }
  const text = pick.text.trim();
  return text && question.allowCustomAnswer !== false ? { [question.id]: text } : null;
}
