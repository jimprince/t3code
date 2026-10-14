// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ChiefOfStaffTray } from "./ChiefOfStaffTray";
import { useCosTrayStore } from "./cosTrayStore";

const { answerOption, respond, cleanupAnswers, answers, projects } = vi.hoisted(() => {
  const answerOption = vi.fn();
  const respond = vi.fn();
  const cleanupAnswers = vi.fn();
  return {
    answerOption,
    respond,
    cleanupAnswers,
    answers: {
      records: new Map(),
      stateOf: () => null,
      reconcile: vi.fn(),
      answerOption,
      respond,
    },
    projects: [
      {
        key: "env|project",
        environmentId: "env",
        project: {
          title: "Delivery",
          rootThreadId: null,
          tasks: [],
          attention: [
            {
              id: "decision",
              kind: "decision",
              title: "Choose the clinic name",
              question: "Which name should we use?",
              taskId: null,
              threadId: null,
              deadline: null,
              blockingTaskIds: [],
              options: [{ text: "Hold the purchase", recommended: true }],
            },
          ],
        },
      },
    ],
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
}));
vi.mock("../../state/chiefOfStaff", () => ({
  useChiefOfStaff: () => ({
    ref: { environmentId: "env", threadId: "cos" },
    waiting: 1,
    replying: false,
    lastReplyAt: null,
  }),
}));
vi.mock("../../state/dashboard", () => ({ useDashboardData: () => ({ data: { projects } }) }));
vi.mock("../dashboard-v3/prefs", () => ({ useMinuteClock: () => 0 }));
vi.mock("../dashboard-v3/useDecisionAnswers", async () => {
  const { useEffect } = await import("react");
  return {
    useDecisionAnswers: () => {
      useEffect(() => cleanupAnswers, []);
      return answers;
    },
    answerMode: () => "option",
  };
});
vi.mock("../orchestrators/ProjectRequestsSection", () => ({ useDiscuss: () => ({}) }));
vi.mock("../ChatView", () => ({
  default: () => <textarea aria-label="Message Chief of Staff" defaultValue="Keep my draft" />,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  useCosTrayStore.setState({ mode: "open", expanded: false, phone: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<ChiefOfStaffTray />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.getAttribute("aria-label") === label || element.textContent === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

describe("Chief of Staff decision exit", () => {
  it("hides and reopens decisions without answering, losing the draft, or disposing pending answers", async () => {
    const pin = container.querySelector<HTMLElement>('[data-testid="cos-decision-pin"]')!;
    const draft = container.querySelector("textarea");
    await act(() => button("Hide decisions").click());
    expect(pin.hidden).toBe(true);
    expect(container.querySelector("textarea")).toBe(draft);
    expect(draft?.value).toBe("Keep my draft");
    expect(answerOption).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(cleanupAnswers).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("1 waiting on you"));
    expect(button("1 waiting on you").getAttribute("aria-expanded")).toBe("false");

    await act(() => button("1 waiting on you").click());
    expect(container.querySelector('[data-testid="cos-decision-pin"]')).toBe(pin);
    expect(pin.hidden).toBe(false);
    expect(button("1 waiting on you").getAttribute("aria-expanded")).toBe("true");
    await act(() => button("Hold the purchase").click());
    expect(answerOption).toHaveBeenCalledOnce();
    expect(answerOption.mock.calls[0]?.[1]).toBe("Hold the purchase");
  });

  it("lets Escape leave a focused decision, while tray controls remain available", async () => {
    const pin = container.querySelector<HTMLElement>('[data-testid="cos-decision-pin"]')!;
    const option = button("Hold the purchase");
    option.focus();
    await act(() =>
      option.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(pin.hidden).toBe(true);
    expect(answerOption).not.toHaveBeenCalled();
    await act(() => button("Expand the Chief of Staff tray").click());
    expect(useCosTrayStore.getState().expanded).toBe(true);
    await act(() => button("Minimize the Chief of Staff tray").click());
    expect(container.querySelector('[data-testid="cos-rail"]')).not.toBeNull();
    await act(() => button("Open the Chief of Staff tray").click());
    await act(() => button("Close the Chief of Staff tray").click());
    expect(container.querySelector('[data-testid="cos-tray"]')).toBeNull();
  });
});
