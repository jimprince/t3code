import { ApprovalRequestId } from "@t3tools/contracts";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    memo: <T,>(component: T) => component,
    useEffect: () => undefined,
    useEffectEvent: <T,>(callback: T) => callback,
    useState: <T,>(value: T) => [value, vi.fn()] as const,
  };
});

const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
};

type FunctionElement = ReactElement<
  Record<string, unknown>,
  (props: Record<string, unknown>) => ReactElement
>;

function findOptionButton(node: ReactNode): ReactElement<{ onClick: () => void }> | null {
  if (!node || typeof node !== "object" || !("type" in node) || !("props" in node)) {
    return null;
  }

  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (element.type === "button" && typeof element.props.onClick === "function") {
    return element as ReactElement<{ onClick: () => void }>;
  }

  const children = element.props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findOptionButton(child);
      if (match) return match;
    }
    return null;
  }

  return findOptionButton(children);
}

function renderPanelMarkup() {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ComposerPendingUserInputPanel", () => {
  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanelMarkup();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanelMarkup();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });

  it("keeps option clicks as draft-only actions until Next or Submit is activated", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearTimeout,
      setTimeout,
    });
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    const renderPanel = ComposerPendingUserInputPanel as unknown as (
      props: ComponentProps<typeof ComposerPendingUserInputPanel> & { onAdvance: () => void },
    ) => FunctionElement;

    const panel = renderPanel({
      pendingUserInputs: [prompt],
      respondingRequestIds: [],
      answers: {},
      questionIndex: 0,
      onToggleOption,
      onAdvance,
    });
    const card = panel.type(panel.props);
    const optionButton = findOptionButton(card);

    expect(optionButton).not.toBeNull();
    optionButton?.props.onClick();
    vi.advanceTimersByTime(250);

    expect(onToggleOption).toHaveBeenCalledWith("question-1", "Incremental");
    expect(onAdvance).not.toHaveBeenCalled();
  });
});
