// @vitest-environment jsdom
import {
  EnvironmentId,
  ThreadId,
  ThreadResumeError,
  type DashboardTask,
  type ThreadResumeRefusalReason,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  shell: null as unknown,
  capable: true,
  permitted: true,
  waitForShell: true,
  filePlans: undefined as unknown,
  rpc: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => state.shell,
  useServerConfigs: () =>
    new Map([
      [
        "env-1",
        { environment: { capabilities: state.capable ? { threadResumeFromPlan: true } : {} } },
      ],
    ]),
  waitForThreadShell: () => Promise.resolve(state.waitForShell),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.permitted,
  readEnvironmentScope: (_: unknown, scope: string) =>
    scope === "orchestration:operate" && state.permitted,
}));
// The RPC boundary: the production command, hook and component all run; only the wire is replaced.
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.rpc }));

import { DashboardUiProvider, type DashboardUi } from "./context";
import { TaskRow } from "./parts";

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("stopped-thread");
const NEW_THREAD = ThreadId.make("fresh-thread");
const NOW = Date.parse("2026-10-13T12:00:00.000Z");

const stoppedState = {
  latestRunStatus: "failed" as const,
  hasLiveSession: false,
  hasLiveTurn: false,
  failedSession: true,
};
const shellOf = (todoProgress: unknown, planResumeState?: unknown) => ({
  ...makeThreadFixture({ id: THREAD, environmentId: ENV }),
  todoProgress,
  ...(planResumeState === undefined ? {} : { planResumeState }),
});

const planTask = (overrides: Partial<DashboardTask> = {}): DashboardTask => ({
  id: `thread-plan:${THREAD}`,
  sourceId: "local",
  closedAt: null,
  title: "Port the importer",
  url: null,
  threadId: THREAD,
  workstreamId: "project:root:work",
  status: "working",
  progress: {
    done: 2,
    total: 5,
    planVersion: "todo",
    sourceId: "local",
    confirmedAt: "2026-10-13T11:59:00.000Z",
  },
  movement: {
    state: "unknown",
    doneDelta: null,
    windowMs: 0,
    fromAt: null,
    toAt: "2026-10-13T12:00:00.000Z",
  },
  forecast: null,
  nextStep: "Wire the store",
  attentionIds: [],
  ...overrides,
});

const ui = {
  get data() {
    return {
      asOf: "2026-10-13T12:00:00.000Z",
      sources: [],
      projects: [],
      filePlans: state.filePlans,
    };
  },
  now: NOW,
  sourceHealth: () => null,
  decisionKeysFor: () => [],
  openTask: vi.fn(),
} as unknown as DashboardUi;
const scoped = { key: "env-1|root", environmentId: ENV, project: {} } as never;

let root: Root;
let container: HTMLDivElement;

async function render(task: DashboardTask) {
  await act(() =>
    root.render(
      <DashboardUiProvider value={ui}>
        <TaskRow scoped={scoped} task={task} />
      </DashboardUiProvider>,
    ),
  );
}
const resumeButton = () =>
  [...container.querySelectorAll("button")].find((b) =>
    /Resume|Resuming/.test(b.textContent ?? ""),
  );
const refusal = (reason: ThreadResumeRefusalReason) =>
  AsyncResult.failure(Cause.fail(new ThreadResumeError({ reason, message: `server: ${reason}` })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.shell = shellOf({ completed: 2, total: 5 });
  state.capable = true;
  state.permitted = true;
  state.waitForShell = true;
  state.rpc
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ newThreadId: NEW_THREAD, reused: false }));
  state.navigate.mockReset();
  state.toast.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("plan strip on a thread-plan row", () => {
  it("shows steps done of total and the current step for an active thread, with no resume action", async () => {
    await render(planTask());
    expect(container.querySelector('[aria-label="2 of 5 steps"]')).not.toBeNull();
    expect(container.textContent).toContain("2/5");
    expect(container.textContent).toContain("Wire the store");
    expect(container.textContent).not.toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });

  it("leaves a task that is not a thread plan exactly as it was", async () => {
    await render(
      planTask({
        id: "issue:git.test/brad/repo#4",
        threadId: null,
        title: "Fix it",
        nextStep: null,
      }),
    );
    expect(container.textContent).toContain("Fix it");
    expect(container.textContent).not.toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });
});

describe("stopped thread row", () => {
  beforeEach(() => {
    state.shell = shellOf({ completed: 2, total: 5 }, stoppedState);
  });

  it("shows Stopped, the strip frozen at its last step, and the button", async () => {
    await render(planTask({ status: "blocked" }));
    expect(container.textContent).toContain("Stopped");
    expect(container.textContent).toContain("2/5");
    expect(container.textContent).toContain("Wire the store");
    expect(resumeButton()?.textContent).toBe("Resume from plan");
  });

  it("hides the button, not the Stopped state, without the capability", async () => {
    state.capable = false;
    await render(planTask({ status: "blocked" }));
    expect(container.textContent).toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });

  it("hides the button when the connection cannot operate threads", async () => {
    state.permitted = false;
    await render(planTask({ status: "blocked" }));
    expect(container.textContent).toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });

  it("is not stopped while the thread still has a live turn", async () => {
    state.shell = shellOf({ completed: 2, total: 5 }, { ...stoppedState, hasLiveTurn: true });
    await render(planTask());
    expect(container.textContent).not.toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });

  it("is a focusable button that resumes the thread and opens the new one", async () => {
    await render(planTask({ status: "blocked" }));
    const button = resumeButton()!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(state.rpc).toHaveBeenCalledWith({ environmentId: ENV, input: { threadId: THREAD } });
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENV, threadId: NEW_THREAD },
      }),
    );
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("disables the button as Resuming while pending, and a second click sends nothing", async () => {
    let finish: (value: unknown) => void = () => undefined;
    state.rpc.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await render(planTask({ status: "blocked" }));
    const button = resumeButton()!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(resumeButton()?.textContent).toBe("Resuming");
    expect(resumeButton()?.disabled).toBe(true);
    await act(async () => finish(AsyncResult.success({ newThreadId: NEW_THREAD, reused: false })));
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(resumeButton()?.textContent).toBe("Resume from plan");
  });

  // Idempotence across clicks (a repeat resume returns the same thread with reused: true) is the
  // server's guarantee, asserted in ThreadLaunchService.test.ts ("resume" cases); here only the
  // in-flight guard above is the client's own behaviour.

  it.each([
    ["still_running", "Still running"],
    ["plan_complete", "Plan already complete"],
    ["no_plan", "No plan to resume"],
    ["not_failed", "Thread did not fail"],
  ] as const)("says %s in plain words and stays put", async (reason, words) => {
    state.rpc.mockResolvedValue(refusal(reason));
    await render(planTask({ status: "blocked" }));
    await act(async () => resumeButton()!.click());
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: words }));
    expect(state.navigate).not.toHaveBeenCalled();
    expect(resumeButton()?.textContent).toBe("Resume from plan");
  });

  it("tells the user when the new thread never arrives, instead of opening a missing route", async () => {
    state.waitForShell = false;
    await render(planTask({ status: "blocked" }));
    await act(async () => resumeButton()!.click());
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not open the new thread" }),
    );
  });

  it("refuses without calling the server when the grant was revoked after render", async () => {
    await render(planTask({ status: "blocked" }));
    state.permitted = false;
    await act(async () => resumeButton()!.click());
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This connection cannot change threads or projects." }),
    );
  });
});

describe("issue-linked row", () => {
  const issueTask = (overrides: Partial<DashboardTask> = {}): DashboardTask =>
    planTask({
      id: "issue:git.test/brad/repo#284",
      url: "https://git.test/brad/repo/issues/284",
      title: "Plan progress on the dashboard",
      ...overrides,
    });

  it("shows Stopped and the button when the linked thread is resumable", async () => {
    state.shell = shellOf({ completed: 2, total: 5 }, stoppedState);
    await render(issueTask());
    expect(container.textContent).toContain("#284");
    expect(container.textContent).toContain("Stopped");
    expect(resumeButton()?.textContent).toBe("Resume from plan");
    await act(async () => resumeButton()!.click());
    expect(state.rpc).toHaveBeenCalledWith({ environmentId: ENV, input: { threadId: THREAD } });
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { environmentId: ENV, threadId: NEW_THREAD } }),
    );
  });

  it("shows nothing extra when the linked thread is not resumable", async () => {
    state.shell = shellOf({ completed: 2, total: 5 }, { ...stoppedState, hasLiveTurn: true });
    await render(issueTask());
    expect(container.textContent).not.toContain("Stopped");
    expect(container.textContent).not.toContain("Wire the store");
    expect(resumeButton()).toBeUndefined();
  });

  it("shows nothing extra when the linked thread is settled", async () => {
    state.shell = {
      ...(shellOf({ completed: 2, total: 5 }, stoppedState) as object),
      settledOverride: "settled",
    };
    await render(issueTask());
    expect(container.textContent).not.toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });

  it("shows nothing for an issue with no linked thread", async () => {
    await render(issueTask({ threadId: null }));
    expect(container.textContent).not.toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });
});

describe("file plan from the dashboard snapshot", () => {
  const filePlan = (done: number, total: number, step: string | null) => ({
    [`${ENV}:${THREAD}`]: {
      planPath: "/plans/importer/PLAN.md",
      host: "dev-vm",
      planTitle: "Importer",
      status: "in progress",
      done,
      total,
      currentStep: step ? { id: "s", text: step, status: "pending" as const } : null,
      hasResumePoint: true,
    },
  });

  it("makes a thread resumable when its file plan has steps left although its native list is complete", async () => {
    state.shell = shellOf({ completed: 5, total: 5 }, stoppedState);
    await render(planTask({ status: "blocked", nextStep: "native step" }));
    expect(container.textContent).not.toContain("Stopped");
    state.filePlans = filePlan(3, 7, "Rewrite the batch writer");
    await render(planTask({ status: "blocked", nextStep: "native step" }));
    expect(container.textContent).toContain("Stopped");
    expect(container.textContent).toContain("Rewrite the batch writer");
    expect(container.textContent).not.toContain("native step");
    expect(resumeButton()?.textContent).toBe("Resume from plan");
  });

  it("is not stopped when the file plan is complete although the native list has steps left", async () => {
    state.shell = shellOf({ completed: 2, total: 5 }, stoppedState);
    state.filePlans = filePlan(7, 7, null);
    await render(planTask({ status: "blocked" }));
    expect(container.textContent).not.toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
  });

  it("shows Stopped and resumes a thread that has a file plan but never wrote a native todo list", async () => {
    state.shell = shellOf(null, stoppedState);
    await render(planTask({ status: "blocked", nextStep: null }));
    expect(container.textContent).not.toContain("Stopped");
    expect(resumeButton()).toBeUndefined();
    state.filePlans = filePlan(3, 7, "Rewrite the batch writer");
    await render(planTask({ status: "blocked", nextStep: null }));
    expect(container.textContent).toContain("Stopped");
    expect(container.textContent).toContain("Rewrite the batch writer");
    expect(resumeButton()?.textContent).toBe("Resume from plan");
    await act(async () => resumeButton()!.click());
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith({ environmentId: ENV, input: { threadId: THREAD } });
  });

  it("keys the plan by environment, so another server's plan for the same thread id does not apply", async () => {
    state.shell = shellOf(null, stoppedState);
    state.filePlans = {
      [`other-env:${THREAD}`]: Object.values(filePlan(3, 7, "x"))[0],
    };
    await render(planTask({ status: "blocked" }));
    expect(container.textContent).not.toContain("Stopped");
  });

  it("resumes an issue-linked row from the file plan", async () => {
    state.shell = shellOf(null, stoppedState);
    state.filePlans = filePlan(3, 7, "Rewrite the batch writer");
    await render(
      planTask({
        id: "issue:git.test/brad/repo#284",
        url: "https://git.test/x",
        status: "blocked",
      }),
    );
    expect(container.textContent).toContain("Stopped");
    await act(async () => resumeButton()!.click());
    expect(state.rpc).toHaveBeenCalledWith({ environmentId: ENV, input: { threadId: THREAD } });
  });
});
