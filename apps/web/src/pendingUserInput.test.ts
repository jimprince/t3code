import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  setPendingUserInputSelectedOption,
} from "./pendingUserInput";

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over a selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Keep current envelope",
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Scaffold only",
      }),
    ).toBe("Scaffold only");
  });

  it("returns all selected options for multi-select drafts", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabels: ["fast", "careful"],
      }),
    ).toEqual(["fast", "careful"]);
  });

  it("rejects custom text for questions that do not allow custom answers", () => {
    expect(
      resolvePendingUserInputAnswer(
        {
          customAnswer: "typed freeform answer",
        },
        {
          multiple: false,
          custom: false,
        },
      ),
    ).toBeNull();
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabel: "Preserve existing tags",
        },
        "doesn't matter",
      ),
    ).toEqual({
      selectedOptionLabel: undefined,
      customAnswer: "doesn't matter",
    });
  });

  it("preserves multi-select choices when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["repo", "tests"],
        },
        "docs",
      ),
    ).toEqual({
      selectedOptionLabels: ["repo", "tests"],
      customAnswer: "docs",
    });
  });

  it("toggles multi-select options while preserving the custom answer", () => {
    expect(
      setPendingUserInputSelectedOption(
        {
          selectedOptionLabels: ["repo"],
          customAnswer: "docs",
        },
        "tests",
        true,
      ),
    ).toEqual({
      selectedOptionLabels: ["repo", "tests"],
      customAnswer: "docs",
    });
  });

  it("removes a multi-select option when it is already selected", () => {
    expect(
      setPendingUserInputSelectedOption(
        {
          selectedOptionLabels: ["repo", "tests"],
        },
        "repo",
        true,
      ),
    ).toEqual({
      selectedOptionLabels: ["tests"],
      customAnswer: "",
    });
  });

  it("treats single-select questions as exclusive", () => {
    expect(
      setPendingUserInputSelectedOption(
        {
          selectedOptionLabel: "repo",
          customAnswer: "docs",
        },
        "tests",
        false,
      ),
    ).toEqual({
      selectedOptionLabel: "tests",
      customAnswer: "",
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
          },
        ],
        {
          scope: {
            selectedOptionLabel: "Orchestration-first",
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });

  it("returns array answers for multi-select questions and accepts custom-only prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "mode",
            header: "Mode",
            question: "Which modes should be enabled?",
            options: [
              {
                label: "fast",
                description: "Fast path",
              },
              {
                label: "careful",
                description: "More checks",
              },
            ],
            multiple: true,
            custom: false,
          },
          {
            id: "details",
            header: "Details",
            question: "Describe the desired behavior.",
            options: [],
            custom: true,
          },
        ],
        {
          mode: {
            selectedOptionLabels: ["fast", "careful"],
          },
          details: {
            customAnswer: "Keep the fix scoped to the current turn",
          },
        },
      ),
    ).toEqual({
      mode: ["fast", "careful"],
      details: "Keep the fix scoped to the current turn",
    });
  });

  it("appends a custom answer to multi-select responses when both are present", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "mode",
            header: "Mode",
            question: "Which modes should be enabled?",
            options: [
              {
                label: "fast",
                description: "Fast path",
              },
            ],
            multiple: true,
            custom: true,
          },
        ],
        {
          mode: {
            selectedOptionLabels: ["fast"],
            customAnswer: "careful",
          },
        },
      ),
    ).toEqual({
      mode: ["fast", "careful"],
    });
  });

  it("returns null when an option-only question only has custom text", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What scope should I use?",
            options: [
              {
                label: "repo",
                description: "Repository root",
              },
            ],
            custom: false,
          },
        ],
        {
          scope: {
            customAnswer: "single file",
          },
        },
      ),
    ).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "What should the plan target first?",
      options: [
        {
          label: "Orchestration-first",
          description: "Focus on orchestration first",
        },
      ],
    },
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("counts multi-select answers as completed", () => {
    expect(
      countAnsweredPendingUserInputQuestions(
        [
          {
            id: "mode",
            header: "Mode",
            question: "Which modes should be enabled?",
            options: [
              {
                label: "fast",
                description: "Fast path",
              },
            ],
            multiple: true,
            custom: false,
          },
          {
            id: "details",
            header: "Details",
            question: "Describe the desired behavior.",
            options: [],
            custom: true,
          },
        ],
        {
          mode: {
            selectedOptionLabels: ["fast"],
          },
        },
      ),
    ).toBe(1);
  });

  it("does not count freeform text as answered when custom answers are disabled", () => {
    expect(
      countAnsweredPendingUserInputQuestions(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What scope should I use?",
            options: [
              {
                label: "repo",
                description: "Repository root",
              },
            ],
            custom: false,
          },
        ],
        {
          scope: {
            customAnswer: "single file",
          },
        },
      ),
    ).toBe(0);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabel: "Orchestration-first",
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabel: "Orchestration-first",
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("derives progress for multi-select questions", () => {
    expect(
      derivePendingUserInputProgress(
        [
          {
            id: "mode",
            header: "Mode",
            question: "Which modes should be enabled?",
            options: [
              {
                label: "fast",
                description: "Fast path",
              },
              {
                label: "careful",
                description: "More checks",
              },
            ],
            multiple: true,
            custom: true,
          },
        ],
        {
          mode: {
            selectedOptionLabels: ["fast"],
            customAnswer: "careful",
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      selectedOptionLabel: undefined,
      selectedOptionLabels: ["fast"],
      customAnswer: "careful",
      resolvedAnswer: ["fast", "careful"],
      usingCustomAnswer: true,
      answeredQuestionCount: 1,
      isLastQuestion: true,
      isComplete: true,
      canAdvance: true,
    });
  });

  it("does not allow advance from custom text when the question is option-only", () => {
    expect(
      derivePendingUserInputProgress(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What scope should I use?",
            options: [
              {
                label: "repo",
                description: "Repository root",
              },
            ],
            custom: false,
          },
        ],
        {
          scope: {
            customAnswer: "single file",
          },
        },
        0,
      ),
    ).toMatchObject({
      customAnswer: "single file",
      resolvedAnswer: null,
      answeredQuestionCount: 0,
      isComplete: false,
      canAdvance: false,
    });
  });
});
