// @vitest-environment jsdom
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import { DashboardSnapshot, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import projection from "../blockers/fixtures/blockersProjection.json";

const mocks = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<unknown>,
  snapshot: null as unknown,
  stored: false,
  operate: true,
  decide: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  resumeQueue: vi.fn(),
  resumePlan: vi.fn(),
  navigate: vi.fn(),
}));

// Only the network and storage boundaries are replaced. The sidebar list, its rows, the badges, the
// popovers, the answer area, the answers hook and its Undo hold all run as shipped, over the
// recorded output of the server's dashboard aggregation (fixtures/blockersProjection.json).
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => null,
}));
vi.mock("./useOrchestratorThreads", () => ({ useOrchestratorThreadShells: () => mocks.shells }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  readEnvironmentSupportsPinReorder: () => false,
  readThreadShells: () => [],
  waitForThreadShell: () => Promise.resolve(true),
  useServerConfigs: () =>
    new Map([
      [
        "dev",
        {
          environment: {
            capabilities: {
              decisionAnswers: true,
              threadSettlement: true,
              threadResumeFromPlan: true,
            },
          },
        },
      ],
    ]),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/dashboard", () => ({
  useBlockerSnapshot: () => ({ snapshot: mocks.snapshot, stored: mocks.stored }),
  refreshDashboard: vi.fn(),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => mocks.operate,
}));
vi.mock("../../state/liveRuntimeRequests", () => ({
  useLiveRuntimeRequests: () => ({ environments: new Set<string>(), threads: new Set<string>() }),
}));
vi.mock("../../state/threadLinks", () => ({
  resolveThreadLinkTarget: (environmentId: string, threadId: string) => ({
    environmentId,
    threadId,
  }),
}));
vi.mock("../../state/threadResume", () => ({ resumeThreadFromPlan: "resumePlan" }));
vi.mock("../../state/projectIssues", () => ({ decideProjectRequest: "decide" }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    settle: "settle",
    unsettle: "unsettle",
    resumeThreadQueue: "resumeQueue",
    respondToApproval: "approval",
    respondToUserInput: "input",
    startTurn: "startTurn",
  },
}));
const commands = () =>
  ({
    decide: mocks.decide,
    settle: mocks.settle,
    unsettle: mocks.unsettle,
    resumeQueue: mocks.resumeQueue,
    resumePlan: mocks.resumePlan,
  }) as Record<string, ReturnType<typeof vi.fn> | undefined>;
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => commands()[command] ?? vi.fn(),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: string) => commands()[command] ?? vi.fn(),
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ pinThread: vi.fn(), reorderPinnedThread: vi.fn() }),
}));
vi.mock("../../hooks/useThreadActionMenu", () => ({ useThreadActionMenu: () => vi.fn() }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./ProjectRequestsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProjectRequestsSection")>()),
  useDiscuss: () => ({ start: vi.fn(), pending: null }),
}));

import { OrchestratorSidebarList } from "./OrchestratorSidebarList";

const DEV = EnvironmentId.make("dev");
const now = new Date().toISOString();
const decode = Schema.decodeUnknownSync(DashboardSnapshot);
const success = (value: unknown = {}) => ({ _tag: "Success", value });
const refusal = (message: string) => ({ _tag: "Failure", cause: Cause.fail(new Error(message)) });

/** A thread as the sidebar holds it; `source` overrides what the server's shell says. */
function thread(
  id: string,
  title: string,
  options: { parent?: string; source?: Record<string, unknown> } = {},
): OrchestratorThreadShell {
  const base = makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: DEV,
    title,
    latestUserMessageAt: now,
  });
  return {
    ...presentThreadShell(DEV, { ...base.source, ...options.source } as never),
    parentThreadId: options.parent ? ThreadId.make(options.parent) : null,
    remoteParent: null,
    subproject: "auto" as const,
    purpose: null,
    supervisionMetadataPresent: true,
  } as OrchestratorThreadShell;
}

const failedRetry = (n: number) =>
  thread(`retry-r${n}`, `v3-next-retired-r${n}`, {
    parent: "dashboard-head",
    source: { status: "failed", latestRunId: `run-${n}`, lastError: "Model at capacity" },
  });
const heldQueue = thread("held-queue", "Dev server lane", {
  parent: "product-head",
  source: { status: "queued", queueHeld: true },
});
const stoppedPlan = thread("stopped-plan", "Plan lane", {
  parent: "product-head",
  source: {
    status: "interrupted",
    todoProgress: {
      completed: 1,
      total: 3,
      currentStep: { id: "s2", text: "Verify the fix", status: "pending" },
    },
    planResumeState: {
      latestRunStatus: "interrupted",
      hasLiveTurn: false,
      hasLiveSession: false,
      failedSession: false,
    },
  },
});
const tree = (...extra: OrchestratorThreadShell[]) => [
  thread("head", "T3 Orchestrator"),
  { ...thread("product-head", "Product", { parent: "head" }), subproject: "on" as const },
  {
    ...thread("dashboard-head", "Dashboard", { parent: "product-head" }),
    subproject: "on" as const,
  },
  ...extra.map((shell) => ({ ...shell, subproject: "auto" as const })),
];

let root: Root;
let container: HTMLDivElement;

const render = () => act(async () => root.render(<OrchestratorSidebarList />));
const rowOf = (title: string) =>
  container.querySelector(`button[aria-label^="Open ${title} subproject"]`)!.parentElement!;
const badge = (title: string, prefix: string) =>
  rowOf(title).querySelector<HTMLButtonElement>(`button[aria-label^="${prefix}"]`);
const popup = () => document.body.querySelector<HTMLElement>('[data-slot="popover-popup"]');
const open = async (title: string, prefix: string) => {
  const trigger = badge(title, prefix);
  expect(trigger, `${prefix} badge on ${title}`).not.toBeNull();
  await act(async () => trigger!.click());
  expect(popup()).not.toBeNull();
};
const button = (label: string) => {
  const found = [...popup()!.querySelectorAll<HTMLButtonElement>("button")].find((element) =>
    element.textContent?.startsWith(label),
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
};
const HOLD_MS = 5000;
const hold = () => act(async () => void (await vi.advanceTimersByTimeAsync(HOLD_MS + 50)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.operate = true;
  mocks.stored = false;
  mocks.snapshot = decode(projection);
  mocks.shells = tree(failedRetry(1), failedRetry(2), failedRetry(3));
  mocks.decide.mockResolvedValue(success({ notifiedThreadId: null, commentUrl: "http://git/c1" }));
  mocks.settle.mockResolvedValue(success());
  mocks.unsettle.mockResolvedValue(success());
  mocks.resumeQueue.mockResolvedValue(success());
  mocks.resumePlan.mockResolvedValue(success({ newThreadId: "fresh-thread", reused: false }));
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

describe("Blocked badge on a sidebar subproject row", () => {
  it("names the failed retries and settles all three on one explicit click, with Undo", async () => {
    await render();
    // Nothing is settled on its own just because the list rendered.
    expect(mocks.settle).not.toHaveBeenCalled();
    await open("Dashboard", "Blocked");
    expect(popup()!.textContent).toContain("Blocked: v3-next-retired-r1 and 2 more");
    // The list shows the first three; each names its thread and the reason.
    for (const n of [1, 2, 3]) expect(popup()!.textContent).toContain(`v3-next-retired-r${n}`);
    expect(popup()!.textContent).toContain("Model at capacity");
    expect(mocks.settle).not.toHaveBeenCalled();

    await act(async () => button("Settle 3").click());
    expect(mocks.settle.mock.calls.map(([call]) => call.input.threadId)).toEqual([
      "retry-r1",
      "retry-r2",
      "retry-r3",
    ]);
    expect(popup()!.textContent).toContain("Settled 3");

    await act(async () => button("Undo").click());
    expect(mocks.unsettle.mock.calls.map(([call]) => call.input)).toEqual(
      ["retry-r1", "retry-r2", "retry-r3"].map((threadId) => ({ threadId, reason: "user" })),
    );
    expect(popup()!.textContent).toContain("Restored 3");
  });

  it("keeps the receipt and Undo after the push settles the row, and says what was refused", async () => {
    await render();
    await open("Dashboard", "Blocked");
    mocks.settle.mockResolvedValueOnce(success()).mockResolvedValueOnce(refusal("Thread is busy"));
    await act(async () => button("Settle 3").click());
    expect(popup()!.textContent).toContain("Settled 1 of 3: Thread is busy");
    // The next push removes the settled one; the popover and its Undo stay until closed.
    mocks.shells = tree(failedRetry(2), failedRetry(3));
    await render();
    expect(popup()!.textContent).toContain("Settled 1 of 3");
    expect(button("Undo")).toBeDefined();
  });

  it("rolls the failures up into Product, attributed to Dashboard", async () => {
    await render();
    await open("Product", "Blocked");
    expect(popup()!.textContent).toContain("in Dashboard");
    expect(button("Settle 3")).toBeDefined();
  });

  it("offers no Settle without permission, only the explanation", async () => {
    mocks.operate = false;
    await render();
    await open("Dashboard", "Blocked");
    expect(popup()!.textContent).toContain("Operating this thread requires operate permission.");
    expect(popup()!.textContent).not.toContain("Settle");
  });

  it("resumes a held queue on its own button and says so", async () => {
    mocks.shells = tree(heldQueue);
    await render();
    await open("Product", "Blocked");
    expect(popup()!.textContent).toContain("Queued work is held until you resume the queue.");
    await act(async () => button("Resume queue").click());
    expect(mocks.resumeQueue.mock.calls[0]![0].input).toEqual({ threadId: "held-queue" });
    expect(popup()!.textContent).toContain("Queue resumed");
  });

  it("resumes a stopped plan, then opens the fresh thread from the receipt", async () => {
    mocks.shells = tree(stoppedPlan);
    await render();
    await open("Product", "Blocked");
    expect(popup()!.textContent).toContain("Verify the fix");
    await act(async () => button("Resume from plan").click());
    expect(mocks.resumePlan.mock.calls[0]![0].input).toEqual({ threadId: "stopped-plan" });
    expect(popup()!.textContent).toContain("Resumed in a new thread");
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => button("Open thread").click());
    expect(mocks.navigate.mock.calls[0]![0].params).toMatchObject({ threadId: "fresh-thread" });
  });

  it("shows a typed refusal in the receipt when the resume is refused", async () => {
    mocks.shells = tree(heldQueue);
    mocks.resumeQueue.mockResolvedValue(refusal("Queue is not held"));
    await render();
    await open("Product", "Blocked");
    await act(async () => button("Resume queue").click());
    expect(popup()!.textContent).toContain("Queue is not held");
  });
});

describe("Waiting on Brad badge on a sidebar subproject row", () => {
  it("counts every item and reads the head's headline for Dashboard", async () => {
    await render();
    expect(badge("Dashboard", "Waiting on Brad")!.textContent).toContain("2");
    await open("Dashboard", "Waiting on Brad");
    expect(popup()!.textContent).toContain("Waiting on Brad: review #304 and 1 more");
  });

  it("lists Product's twelve items and Dashboard's two, first three open for answering", async () => {
    await render();
    await open("Product", "Waiting on Brad");
    const text = () => popup()!.textContent!;
    expect(text()).toContain("Waiting on Brad: test #352 and 13 more");
    expect(text()).toContain("Blocked badges name the blocker");
    expect(text()).toContain("Passed");
    expect(text()).not.toContain("Code signing: which certificate?");
    await act(async () => button("and 11 more").click());
    for (const title of [
      "Answer from the Needs you card",
      "Review the signing notes",
      "Code signing: which certificate?",
      "Review the Plan header",
      "Review the Done list",
    ])
      expect(text()).toContain(title);
    expect(popup()!.querySelectorAll('[data-testid="blocker-item"]')).toHaveLength(14);
  });

  it("reads Product's own twelve as the head decided when Dashboard is not nested under it", async () => {
    const separate = decode({
      ...projection,
      projects: projection.projects.map((project) =>
        project.title === "Dashboard" ? { ...project, parentId: null } : project,
      ),
    });
    mocks.snapshot = separate;
    await render();
    expect(badge("Product", "Waiting on Brad")!.textContent).toContain("12");
    await open("Product", "Waiting on Brad");
    expect(popup()!.textContent).toContain("Waiting on Brad: test #352 and 11 more");
  });

  it("keeps an answered item's receipt and Undo after the snapshot drops it", async () => {
    await render();
    await open("Dashboard", "Waiting on Brad");
    await act(async () => button("Approve and close").click());
    await hold();
    // The next push no longer lists #304; the popover still shows what was sent.
    mocks.snapshot = decode({
      ...projection,
      projects: projection.projects.map((project) =>
        project.title === "Dashboard"
          ? { ...project, attention: project.attention.filter((item) => !item.id.includes("#304")) }
          : project,
      ),
    });
    await render();
    expect(popup()!.textContent).toContain("Sent “Approve and close”");
    expect(badge("Dashboard", "Waiting on Brad")!.textContent).toContain("1");
  });

  it("labels the stored copy as of a time inside the popover only", async () => {
    mocks.stored = true;
    await render();
    expect(container.textContent).not.toContain("as of");
    await open("Dashboard", "Waiting on Brad");
    expect(popup()!.textContent).toMatch(/Waiting on Brad: review #304 and 1 more · as of /);
  });

  it("answers from the popover through the same service as the Decisions card, with Undo", async () => {
    await render();
    await open("Dashboard", "Waiting on Brad");
    await act(async () => button("Approve and close").click());
    expect(popup()!.textContent).toContain("Sending “Approve and close”");
    expect(mocks.decide).not.toHaveBeenCalled();
    await hold();
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide.mock.calls[0]![0].input).toMatchObject({
      threadId: "dashboard-head",
      reference: "brad/fork#304",
      decision: "approve",
    });
    expect(popup()!.textContent).toContain("Sent “Approve and close”");
  });

  it("holds a click for Undo and sends nothing if it is undone", async () => {
    await render();
    await open("Dashboard", "Waiting on Brad");
    await act(async () => button("Reject").click());
    await act(async () => button("Undo").click());
    await hold();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(button("Reject")).toBeDefined();
  });

  it("falls back to the plain thread count until a snapshot exists", async () => {
    mocks.snapshot = null;
    mocks.shells = tree();
    await render();
    expect(badge("Dashboard", "Waiting on Brad")).toBeNull();
  });
});
