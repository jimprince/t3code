// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type DashboardAttention } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  respondToUserInput: vi.fn(),
  respondToApproval: vi.fn(),
  startTurn: vi.fn(),
  refresh: vi.fn(),
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
vi.mock("../../state/dashboard", () => ({ refreshDashboard: mocks.refresh }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    respondToApproval: "approval",
    respondToUserInput: "input",
    startTurn: "startTurn",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "decide"
      ? mocks.decide
      : command === "input"
        ? mocks.respondToUserInput
        : command === "startTurn"
          ? mocks.startTurn
          : mocks.respondToApproval,
}));
vi.mock("../../state/entities", () => ({
  readThreadShells: () => [
    {
      id: "asking-thread",
      environmentId: "env-1",
      title: "Mac agent",
      modelSelection: { instanceId: "codex", model: "gpt" },
      runtimeMode: "full-access",
      interactionMode: "default",
      runtime: { status: "idle" },
    },
  ],
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
vi.mock("../orchestrators/DecisionMarkdown", () => ({
  DecisionMarkdown: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
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

const captured: { answers: ReturnType<typeof useDecisionAnswers> | null } = { answers: null };

function Harness({
  row,
  compact,
  full,
}: {
  readonly row: DecisionRow;
  readonly compact?: boolean;
  readonly full?: boolean;
}) {
  const answers = useDecisionAnswers();
  captured.answers = answers;
  const ui = { answers, now: 0, openTask: vi.fn() } as unknown as DashboardUi;
  return (
    <DashboardUiProvider value={ui}>
      <DecisionCard row={row} compact={compact ?? false} full={full ?? false} />
    </DashboardUiProvider>
  );
}

const render = async (row: DecisionRow, view: { compact?: boolean; full?: boolean } = {}) =>
  act(async () => root.render(<Harness row={row} {...view} />));

const refusal = (message: string) => ({ _tag: "Failure", cause: Cause.fail(new Error(message)) });

function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) =>
    element.textContent?.startsWith(label),
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

const box = () => container.querySelector<HTMLTextAreaElement>("textarea")!;

async function type(text: string) {
  const input = box();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A keydown on the box; resolves true when the page's default (a newline) was left alone. */
async function key(name: string, init: KeyboardEventInit & { keyCode?: number } = {}) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => void box().dispatchEvent(event));
  return !event.defaultPrevented;
}

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
  mocks.respondToApproval.mockResolvedValue({ _tag: "Success", value: {} });
  mocks.startTurn.mockResolvedValue({ _tag: "Success", value: {} });
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
    expect(container.querySelector("textarea")).toBeNull();

    const { answer: _answer, ...older } = REVIEW;
    await render(rowOf({ ...older, options: [] }));
    expect(container.querySelector("textarea")).toBeNull();
    expect(button("Open")).toBeDefined();
    expect(container.textContent).not.toContain("Approve and close");
  });
});

const TEST = attention({
  answer: "issue-test",
  summary: "The Plan strip now wraps long titles.",
  options: [
    { text: "Passed", recommended: true, action: "approve", effect: "settle" },
    { text: "Failed", recommended: false, action: "reject" },
  ],
});

describe("what the box holds travels with a click, or stands alone as Brad's answer", () => {
  it("typed words alone are his answer, never a Passed or Failed", async () => {
    await render(rowOf(TEST));
    await type("works");
    await key("Enter");
    await hold();
    const input = mocks.decide.mock.calls[0]![0].input;
    expect(input).toMatchObject({
      decision: "answer",
      answer: "works",
      actor: "brad",
      expectAnswer: "issue-test",
    });
    expect(input.reason).toBeUndefined();
  });

  it("Passed with text sends the text as its note; Failed does the same", async () => {
    await render(rowOf(TEST));
    await type("Checked on the phone too");
    await act(() => button("Passed").click());
    expect(container.textContent).toContain("Passed with your note");
    await hold();
    expect(mocks.decide.mock.calls[0]![0].input).toMatchObject({
      decision: "approve",
      reason: "Checked on the phone too",
      actor: "brad",
    });
    expect(mocks.decide.mock.calls[0]![0].input.answer).toBeUndefined();

    await render(rowOf({ ...TEST, id: "a2" }));
    await type("The button is hidden under the strip");
    await act(() => button("Failed").click());
    await hold();
    expect(mocks.decide.mock.calls[1]![0].input).toMatchObject({
      decision: "reject",
      reason: "The button is hidden under the strip",
    });
  });

  it("a Failed that says to type its note opens the box instead of sending bare", async () => {
    const asking = attention({
      ...TEST,
      options: [
        { text: "Passed", recommended: true, action: "approve", effect: "settle" },
        { text: "Failed (type what is wrong)", recommended: false, action: "reject" },
      ],
    });
    await render(rowOf(asking), { compact: true });
    await act(() => button("Failed (type").click());
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(box()).toBeDefined();
    await type("Nothing happens on tap");
    await act(() => button("Failed (type").click());
    await hold();
    expect(mocks.decide.mock.calls[0]![0].input).toMatchObject({
      decision: "reject",
      reason: "Nothing happens on tap",
    });
  });

  it("a click on an empty box sends no note", async () => {
    await render(rowOf(TEST));
    await act(() => button("Passed").click());
    await hold();
    expect(mocks.decide.mock.calls[0]![0].input.reason).toBeUndefined();
  });

  it("Approve and close on a review comes from Brad and says what the card was", async () => {
    await render(rowOf(REVIEW));
    await act(() => button("Approve and close").click());
    await hold();
    expect(mocks.decide.mock.calls[0]![0].input).toMatchObject({
      decision: "approve",
      actor: "brad",
      expectAnswer: "issue-review",
    });
  });
});

describe("the box takes several lines", () => {
  it("Shift+Enter makes a new line, Enter sends it whole", async () => {
    await render(rowOf(REVIEW));
    await type("first line\nsecond line");
    expect(await key("Enter", { shiftKey: true })).toBe(true);
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(await key("Enter")).toBe(false);
    await hold();
    expect(mocks.decide.mock.calls[0]![0].input.answer).toBe("first line\nsecond line");
  });

  it("leaves an IME's confirming Enter alone", async () => {
    await render(rowOf(REVIEW));
    await type("かんじ");
    expect(await key("Enter", { isComposing: true })).toBe(true);
    expect(await key("Enter", { keyCode: 229 })).toBe(true);
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});

describe("a typed answer is never lost to Undo, a double Enter or a failure", () => {
  it("Undo brings the card back with the draft still in the box", async () => {
    await render(rowOf(REVIEW));
    await type("keep the old width on phones");
    await key("Enter");
    // The second Enter of a double press lands on the focused Undo.
    await act(() => button("Undo").click());
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(box().value).toBe("keep the old width on phones");
  });

  it("a note held behind an option click survives Undo too", async () => {
    await render(rowOf(TEST));
    await type("saw it fail once");
    await act(() => button("Failed").click());
    await act(() => button("Undo").click());
    expect(box().value).toBe("saw it fail once");
  });

  it("a refused send keeps the draft, offers Retry, and Edit puts it back in the box", async () => {
    mocks.decide.mockResolvedValueOnce(refusal("Gitea is unreachable"));
    await render(rowOf(REVIEW));
    await type("approved with a caveat");
    await key("Enter");
    await hold();
    expect(container.textContent).toContain("Not sent");
    expect(container.textContent).toContain("Gitea is unreachable");
    await act(() => button("Edit").click());
    expect(box().value).toBe("approved with a caveat");
  });

  it("a delivered answer ends its draft", async () => {
    await render(rowOf(REVIEW));
    await type("done and dusted");
    await key("Enter");
    await hold();
    expect(captured.answers!.draftOf(rowOf(REVIEW).key)).toBe("");
  });

  it("picks on a multi-question ask come back after Undo", async () => {
    const asking = attention({
      id: "q3",
      taskId: "thread:asking-thread",
      requestId: "req-3",
      kind: "question",
      answer: "thread-question",
      canRespond: true,
      threadId: ASKING,
      title: "Dashboard",
      questions: [
        {
          id: "head",
          header: "Owner",
          question: "Who?",
          options: [{ label: "This VM head", description: "" }],
        },
        {
          id: "when",
          header: "When",
          question: "When?",
          options: [{ label: "Now", description: "" }],
          allowCustomAnswer: false,
        },
      ],
    });
    await render(rowOf(asking));
    await act(() => button("This VM head").click());
    await act(() => button("Now").click());
    await act(() => button("Send answers").click());
    await act(() => button("Undo").click());
    expect(button("Send answers").disabled).toBe(false);
    expect(button("This VM head").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("a card that went stale before the click", () => {
  it("says so, refreshes the list, and offers no Retry that would resend it", async () => {
    mocks.decide.mockResolvedValueOnce(refusal("This item is no longer waiting on you."));
    await render(rowOf(REVIEW));
    await act(() => button("Approve and close").click());
    await hold();
    expect(container.textContent).toContain("no longer waits on you");
    expect(mocks.refresh).toHaveBeenCalledWith(ENV);
    expect(container.textContent).not.toContain("Retry");
    expect(button("Dismiss")).toBeDefined();
  });
});

describe("an approval takes a reason", () => {
  const APPROVAL = attention({
    id: "ap1",
    taskId: "thread:asking-thread",
    requestId: "req-ap",
    kind: "approval",
    answer: "thread-approval",
    canRespond: true,
    threadId: ASKING,
    title: "Run a command",
  });

  it("Decline and send declines first, then tells the thread why", async () => {
    await render(rowOf(APPROVAL));
    await type("Not against production");
    // Enter alone never declines an approval.
    expect(await key("Enter")).toBe(true);
    await hold();
    expect(mocks.respondToApproval).not.toHaveBeenCalled();
    await act(() => button("Decline and send").click());
    await hold();
    expect(mocks.respondToApproval.mock.calls[0]![0].input).toMatchObject({
      threadId: ASKING,
      decision: "decline",
    });
    const sent = mocks.startTurn.mock.calls[0]![0].input;
    expect(sent.threadId).toBe(ASKING);
    expect(sent.message.text).toBe("Declined: Not against production");
    expect(container.textContent).toContain("Sent “Declined: Not against production”");
  });

  it("a message that failed is retried alone, as the same message", async () => {
    mocks.startTurn.mockResolvedValueOnce(refusal("Thread is archived"));
    await render(rowOf(APPROVAL));
    await type("Wrong branch");
    await act(() => button("Decline and send").click());
    await hold();
    expect(container.textContent).toContain("Declined, but the message was not sent");
    await act(() => button("Retry").click());
    expect(mocks.respondToApproval).toHaveBeenCalledOnce();
    expect(mocks.startTurn).toHaveBeenCalledTimes(2);
    expect(mocks.startTurn.mock.calls[1]![0].input.message.messageId).toBe(
      mocks.startTurn.mock.calls[0]![0].input.message.messageId,
    );
  });

  it("Allow and Decline still work with no text", async () => {
    await render(rowOf(APPROVAL));
    await act(() => button("Allow once").click());
    await hold();
    expect(mocks.respondToApproval.mock.calls[0]![0].input.decision).toBe("accept");
    expect(mocks.startTurn).not.toHaveBeenCalled();
  });
});

describe("the card's text", () => {
  const WHERE = attention({
    ...REVIEW,
    judgingWhere: "Open Dev after Update #355, Plan column",
    recommended: "Approve and close",
  });

  it("the tray strip shows Where on one line without opening Details", async () => {
    await render(rowOf(WHERE), { compact: true });
    const where = [...container.querySelectorAll("div")].find((el) =>
      el.textContent?.startsWith("Where:"),
    );
    expect(where?.textContent).toContain("Plan column");
    expect(where?.className).toContain("truncate");
  });

  it("See all shows the producer's whole text, not just the summary", async () => {
    await render(
      rowOf(
        attention({
          ...REVIEW,
          question: "Widened the Plan column from 14 to 24 characters.\n\nAlso fixes the wrap.",
        }),
      ),
      { full: true },
    );
    expect(container.textContent).toContain("Also fixes the wrap.");
  });
});
