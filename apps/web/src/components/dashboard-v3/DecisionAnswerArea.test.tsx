// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type DashboardAttention } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  respondToUserInput: vi.fn(),
  respondToApproval: vi.fn(),
  decisionAnswers: true,
  navigate: vi.fn(),
}));

// Only the network boundary is replaced: the card, the answer area, the answers hook and the Undo
// hold all run as shipped.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
// The thread that was told lives on another machine than the project's environment.
vi.mock("../../state/threadLinks", () => ({
  resolveThreadLinkTarget: (_environmentId: string, threadId: string) => ({
    environmentId: "env-2",
    threadId,
  }),
}));
vi.mock("../../state/projectIssues", () => ({ decideProjectRequest: "decide" }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToApproval: "approval", respondToUserInput: "input" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "decide"
      ? mocks.decide
      : command === "input"
        ? mocks.respondToUserInput
        : mocks.respondToApproval,
}));
vi.mock("../../state/entities", () => ({
  readThreadShells: () => [],
  useServerConfigs: () =>
    new Map([
      [
        "env-1",
        {
          environment: {
            capabilities: mocks.decisionAnswers ? { decisionAnswers: true } : {},
          },
        },
      ],
    ]),
}));
vi.mock("../orchestrators/ProjectRequestsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../orchestrators/ProjectRequestsSection")>()),
  useDiscuss: () => ({ start: vi.fn(), pending: null }),
}));

import { DecisionCard } from "./decisions";
import { DashboardUiProvider, type DashboardUi, type DecisionRow } from "./context";
import { useDecisionAnswers } from "./useDecisionAnswers";

const ENV = EnvironmentId.make("env-1");
const HEAD = ThreadId.make("head-thread");
const ASKING = ThreadId.make("asking-thread");

const attention = (patch: Partial<DashboardAttention>): DashboardAttention => ({
  id: "a1",
  taskId: "issue:git/o/r#355",
  requestId: null,
  blockingTaskIds: [],
  title: "Widen the Plan so task titles are readable",
  kind: "review",
  canRespond: false,
  options: [],
  priority: 1,
  url: "http://git/o/r/issues/355",
  threadId: null,
  updatedAt: "2026-10-15T12:00:00.000Z",
  deadline: null,
  question: "",
  sourceId: "gitea:git/o/r",
  ...patch,
});

const rowOf = (item: DashboardAttention): DecisionRow => ({
  key: `env-1:project|${item.id}`,
  scoped: {
    key: "env-1:project",
    environmentId: ENV,
    project: { title: "Dashboard head", rootThreadId: HEAD, tasks: [], attention: [item] },
  } as unknown as DecisionRow["scoped"],
  attention: item,
});

const REVIEW = attention({
  answer: "issue-review",
  summary: "Widened the Plan column from 14 to 24 characters.",
  options: [
    { text: "Approve and close", recommended: true, action: "approve", effect: "settle" },
    { text: "Reject", recommended: false, action: "reject" },
  ],
});

let root: Root;
let container: HTMLDivElement;

function Harness({ row }: { readonly row: DecisionRow }) {
  const answers = useDecisionAnswers();
  const ui = { answers, now: 0, openTask: vi.fn() } as unknown as DashboardUi;
  return (
    <DashboardUiProvider value={ui}>
      <DecisionCard row={row} />
    </DashboardUiProvider>
  );
}

const render = async (row: DecisionRow) => act(async () => root.render(<Harness row={row} />));

function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) =>
    element.textContent?.startsWith(label),
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

const box = () => container.querySelector<HTMLInputElement>("input")!;

async function type(text: string) {
  const input = box();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const key = (name: string) =>
  act(async () => {
    box().dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );
  });

const HOLD_MS = 5000;
const hold = () => act(async () => void (await vi.advanceTimersByTimeAsync(HOLD_MS + 50)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.decisionAnswers = true;
  mocks.decide.mockResolvedValue({
    _tag: "Success",
    value: { notifiedThreadId: HEAD, commentUrl: "http://git/o/r/issues/355#c1" },
  });
  mocks.respondToUserInput.mockResolvedValue({ _tag: "Success", value: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("answering a review item inline", () => {
  it("one option click is held with Undo, then sent with the server's label and confirmed", async () => {
    await render(rowOf(REVIEW));
    await act(() => button("Approve and close").click());
    expect(container.textContent).toContain("Sending “Approve and close” to Dashboard head");
    expect(mocks.decide).not.toHaveBeenCalled();
    await hold();
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide.mock.calls[0]![0].input).toMatchObject({
      threadId: HEAD,
      reference: "o/r#355",
      decision: "approve",
    });
    expect(container.textContent).toContain(
      "Sent “Approve and close” · commented on #355 · told Dashboard head",
    );
    // "Where it landed" opens the thread in the environment that holds it, not the project's.
    await act(() => button("View in thread").click());
    expect(mocks.navigate.mock.calls[0]![0].params).toMatchObject({
      environmentId: "env-2",
      threadId: HEAD,
    });
  });

  it("Undo during the hold cancels the send and brings the options back", async () => {
    await render(rowOf(REVIEW));
    await act(() => button("Reject").click());
    await act(() => button("Undo").click());
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(button("Reject")).toBeDefined();
  });

  it("shows what the agent asked once and never the title twice", async () => {
    await render(rowOf(REVIEW));
    expect(container.textContent).toContain("Widened the Plan column");
    expect(container.textContent?.split(REVIEW.title).length).toBe(2);
    const { summary: _summary, ...bare } = REVIEW;
    await render(rowOf(attention({ ...bare, asksNothingYet: true })));
    expect(container.textContent).toContain("Asks nothing yet");
    expect(container.textContent?.split(REVIEW.title).length).toBe(2);
  });
});

describe("the type-your-own box", () => {
  it("sends a typed answer only on Enter, exactly as an answer decision", async () => {
    await render(rowOf(REVIEW));
    await type("Looks right, but keep the old width on phones");
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
    await key("Enter");
    await hold();
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide.mock.calls[0]![0].input).toMatchObject({
      decision: "answer",
      answer: "Looks right, but keep the old width on phones",
    });
    expect(container.textContent).toContain("commented on #355");
  });

  it("sends on the Send button and not on blur, Esc or time", async () => {
    await render(rowOf(REVIEW));
    await type("Hold it");
    await act(async () => box().blur());
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
    await key("Escape");
    expect(box().value).toBe("");
    expect(button("Send").disabled).toBe(true);
    await type("Hold it");
    await act(() => button("Send").click());
    await hold();
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide.mock.calls[0]![0].input.answer).toBe("Hold it");
  });

  it("keeps an unsent draft when the card re-renders with a new snapshot", async () => {
    await render(rowOf(REVIEW));
    await type("half a thought");
    await render(rowOf(attention({ ...REVIEW })));
    expect(box().value).toBe("half a thought");
  });
});

describe("a thread's own question", () => {
  const QUESTION = attention({
    id: "q1",
    taskId: "thread:asking-thread",
    requestId: "req-1",
    kind: "question",
    answer: "thread-question",
    canRespond: true,
    threadId: ASKING,
    title: "Dashboard",
    question: "Which head should own the dashboard?",
    options: [{ text: "This VM head", recommended: false }],
    questions: [
      {
        id: "head",
        header: "Owner",
        question: "Which head should own the dashboard?",
        options: [
          { label: "This VM head", description: "Stay here" },
          { label: "The Mac head", description: "Move over" },
        ],
      },
    ],
  });

  it("answers an option and a typed answer through the respond path with the question id", async () => {
    await render(rowOf(QUESTION));
    await act(() => button("The Mac head").click());
    await hold();
    expect(mocks.respondToUserInput).toHaveBeenCalledOnce();
    expect(mocks.respondToUserInput.mock.calls[0]![0].input).toMatchObject({
      threadId: ASKING,
      answers: { head: "The Mac head" },
    });
    expect(mocks.decide).not.toHaveBeenCalled();

    await render(rowOf({ ...QUESTION, id: "q2", requestId: "req-2" }));
    await type("Neither: split it");
    await key("Enter");
    await hold();
    expect(mocks.respondToUserInput.mock.calls[1]![0].input.answers).toEqual({
      head: "Neither: split it",
    });
  });

  it("sends several questions in one call, only once each has an answer", async () => {
    const two = {
      ...QUESTION,
      questions: [
        QUESTION.questions![0]!,
        {
          id: "when",
          header: "When",
          question: "When?",
          options: [{ label: "Now", description: "Today" }],
          allowCustomAnswer: false,
        },
      ],
    };
    await render(rowOf(two));
    expect(button("Send answers").disabled).toBe(true);
    await act(() => button("The Mac head").click());
    expect(button("Send answers").disabled).toBe(true);
    await act(() => button("Now").click());
    expect(button("Send answers").disabled).toBe(false);
    await act(() => button("Send answers").click());
    await hold();
    expect(mocks.respondToUserInput).toHaveBeenCalledOnce();
    expect(mocks.respondToUserInput.mock.calls[0]![0].input.answers).toEqual({
      head: "The Mac head",
      when: "Now",
    });
  });
});

describe("hosts without decisionAnswers", () => {
  it("keep today's controls: options on a needs-brad decision, Discuss and Open on a review", async () => {
    mocks.decisionAnswers = false;
    const decision = attention({
      kind: "decision",
      options: [{ text: "Hold the purchase", recommended: true }],
    });
    await render(rowOf(decision));
    expect(button("Hold the purchase")).toBeDefined();
    expect(container.querySelector("input")).toBeNull();

    const { answer: _answer, ...older } = REVIEW;
    await render(rowOf({ ...older, options: [] }));
    expect(container.querySelector("input")).toBeNull();
    expect(button("Open")).toBeDefined();
    expect(container.textContent).not.toContain("Approve and close");
  });
});
