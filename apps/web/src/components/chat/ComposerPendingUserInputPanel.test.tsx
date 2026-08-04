import type { ApprovalRequestId } from "@t3tools/contracts";
import type { ComponentProps, ReactElement, ReactNode } from "react";
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
    useRef: <T,>(value: T) => ({ current: value }),
    useState: <T,>(value: T) => [value, vi.fn()] as const,
  };
});

const prompt = {
  requestId: "request-1" as ApprovalRequestId,
  createdAt: "2026-07-20T00:00:00.000Z",
  questions: [
    {
      id: "control-surface",
      header: "Control surface",
      question: "Where should the controls live?",
      options: [
        {
          label: "Phone",
          description: "Use a phone as the controller.",
        },
      ],
      multiSelect: false,
    },
  ],
} satisfies PendingUserInput;

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ComposerPendingUserInputPanel", () => {
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

    expect(onToggleOption).toHaveBeenCalledWith("control-surface", "Phone");
    expect(onAdvance).not.toHaveBeenCalled();
  });
});
