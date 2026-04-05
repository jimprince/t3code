import "../../index.css";

import { type ApprovalRequestId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { type PendingUserInput } from "../../session-logic";
import { type PendingUserInputDraftAnswer } from "../../pendingUserInput";

const THREE_QUESTION_PROMPT: PendingUserInput = {
  requestId: "request-1" as ApprovalRequestId,
  createdAt: "2026-03-31T00:00:00.000Z",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "What scope should I use?",
      options: [
        { label: "repo", description: "Repository root" },
        { label: "file", description: "Single file" },
      ],
    },
    {
      id: "mode",
      header: "Mode",
      question: "Which mode should I use?",
      options: [{ label: "fast", description: "Fast path" }],
    },
    {
      id: "depth",
      header: "Depth",
      question: "How deep should I go?",
      options: [{ label: "full", description: "Full analysis" }],
    },
  ],
};

const SINGLE_QUESTION_PROMPT: PendingUserInput = {
  requestId: "request-single" as ApprovalRequestId,
  createdAt: "2026-03-31T00:00:30.000Z",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "What scope should I use?",
      options: [
        { label: "repo", description: "Repository root" },
        { label: "file", description: "Single file" },
      ],
    },
  ],
};

function Harness(props: {
  pendingUserInputs?: PendingUserInput[];
  initialQuestionIndex?: number;
  onAdvance?: () => void;
}) {
  const pendingUserInputs = props.pendingUserInputs ?? [THREE_QUESTION_PROMPT];
  const [questionIndex, setQuestionIndex] = useState(props.initialQuestionIndex ?? 0);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          setQuestionIndex((current) =>
            Math.min(current + 1, pendingUserInputs[0]!.questions.length - 1),
          )
        }
      >
        Manual next
      </button>
      <button type="button" onClick={() => setQuestionIndex((current) => Math.max(current - 1, 0))}>
        Manual previous
      </button>
      <button
        type="button"
        onClick={() => setRespondingRequestIds([pendingUserInputs[0]!.requestId])}
      >
        Manual submit
      </button>
      <ComposerPendingUserInputPanel
        pendingUserInputs={pendingUserInputs}
        respondingRequestIds={respondingRequestIds}
        answers={answers}
        questionIndex={questionIndex}
        onSelectOption={(questionId, optionLabel) => {
          setAnswers((existing) => ({
            ...existing,
            [questionId]: {
              selectedOptionLabel: optionLabel,
              customAnswer: "",
            },
          }));
        }}
        onAdvance={() => {
          setQuestionIndex((current) =>
            Math.min(current + 1, pendingUserInputs[0]!.questions.length - 1),
          );
          props.onAdvance?.();
        }}
      />
    </div>
  );
}

describe("ComposerPendingUserInputPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("cancels a queued single-select auto-advance after manual next navigation", async () => {
    const onAdvance = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness onAdvance={onAdvance} />, { container: host });

    try {
      await expect.element(page.getByText("What scope should I use?")).toBeInTheDocument();
      await page.getByRole("button", { name: "repo" }).click();
      await page.getByRole("button", { name: "Manual next" }).click();

      await vi.advanceTimersByTimeAsync(250);

      expect(onAdvance).toHaveBeenCalledTimes(0);
      await expect.element(page.getByText("Which mode should I use?")).toBeInTheDocument();
      expect(document.body.textContent ?? "").not.toContain("How deep should I go?");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("cancels a queued single-select auto-advance after manual previous navigation", async () => {
    const onAdvance = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness initialQuestionIndex={1} onAdvance={onAdvance} />, {
      container: host,
    });

    try {
      await expect.element(page.getByText("Which mode should I use?")).toBeInTheDocument();
      await page.getByRole("button", { name: "fast" }).click();
      await page.getByRole("button", { name: "Manual previous" }).click();

      await vi.advanceTimersByTimeAsync(250);

      expect(onAdvance).toHaveBeenCalledTimes(0);
      await expect.element(page.getByText("What scope should I use?")).toBeInTheDocument();
      expect(document.body.textContent ?? "").not.toContain("Which mode should I use?");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("cancels a queued single-select auto-advance after manual submit", async () => {
    const onAdvance = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <Harness pendingUserInputs={[SINGLE_QUESTION_PROMPT]} onAdvance={onAdvance} />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "repo" }).click();
      await page.getByRole("button", { name: "Manual submit" }).click();

      await vi.advanceTimersByTimeAsync(250);

      expect(onAdvance).toHaveBeenCalledTimes(0);
      await expect.element(page.getByRole("button", { name: "repo" })).toBeDisabled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
