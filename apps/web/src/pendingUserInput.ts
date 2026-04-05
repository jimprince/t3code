import type { UserInputQuestion } from "@t3tools/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabel?: string;
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export type PendingUserInputResolvedAnswer = string | string[];

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabel: string | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: PendingUserInputResolvedAnswer | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  question?: Pick<UserInputQuestion, "multiple" | "custom">,
): PendingUserInputResolvedAnswer | null {
  const customAnswer =
    question?.custom === false ? null : normalizeDraftAnswer(draft?.customAnswer);
  const selectedOptionLabels = (draft?.selectedOptionLabels ?? [])
    .map((label) => normalizeDraftAnswer(label))
    .filter((label): label is string => label !== null);

  if (question?.multiple || selectedOptionLabels.length > 0) {
    const answers = [...selectedOptionLabels, ...(customAnswer ? [customAnswer] : [])];
    return answers.length > 0 ? answers : null;
  }

  if (customAnswer) {
    return customAnswer;
  }

  return normalizeDraftAnswer(draft?.selectedOptionLabel);
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabel =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabel;

  return {
    customAnswer,
    ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
    ...(draft?.selectedOptionLabels && draft.selectedOptionLabels.length > 0
      ? { selectedOptionLabels: draft.selectedOptionLabels }
      : {}),
  };
}

export function setPendingUserInputSelectedOption(
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
  multiple: boolean,
): PendingUserInputDraftAnswer {
  if (!multiple) {
    return {
      selectedOptionLabel: optionLabel,
      customAnswer: "",
    };
  }

  const selectedOptionLabels = draft?.selectedOptionLabels ?? [];
  return {
    selectedOptionLabels: selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel],
    customAnswer: draft?.customAnswer ?? "",
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputResolvedAnswer> | null {
  const answers: Record<string, PendingUserInputResolvedAnswer> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id], question);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(draftAnswers[question.id], question) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(draftAnswers[question.id], question),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeDraft, activeQuestion)
    : null;
  const customAnswer = activeDraft?.customAnswer ?? "";
  const selectedOptionLabels = activeDraft?.selectedOptionLabels ?? [];
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabel: activeDraft?.selectedOptionLabel,
    selectedOptionLabels,
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
