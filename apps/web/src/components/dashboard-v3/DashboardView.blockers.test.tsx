// @vitest-environment jsdom
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildOrchestratorSummaries,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import {
  DashboardSnapshot,
  EnvironmentId,
  ThreadId,
  type DashboardTask,
  type ProjectIssue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import projection from "../blockers/fixtures/blockersProjection.json";

const mocks = vi.hoisted(() => ({
  data: null as unknown,
  shells: [] as ReadonlyArray<unknown>,
  issues: [] as ReadonlyArray<unknown>,
  navigate: vi.fn(),
  decide: vi.fn(),
  resumeQueue: vi.fn(),
}));

// The data, router and command boundaries are replaced; the Dashboard, its rows and badges, the
// sidebar's Waiting badge, the answers provider and its Undo hold all run as shipped.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => mocks.navigate,
  useParams: () => null,
}));
vi.mock("../../state/threadLinks", () => ({
  resolveThreadLinkTarget: (environmentId: string, threadId: string) => ({
    environmentId,
    threadId,
  }),
}));
vi.mock("../../state/liveRuntimeRequests", () => ({
  useLiveRuntimeRequests: () => ({ environments: new Set<string>(), threads: new Set<string>() }),
}));
vi.mock("../../state/dashboard", () => ({
  useDashboardData: () => ({
    data: mocks.data,
    revision: 1,
    snapshotSource: "live",
  }),
  useBlockerSnapshot: () => ({
    snapshot: (mocks.data as { raw?: unknown } | null)?.raw ?? null,
    stored: false,
  }),
  refreshDashboard: vi.fn(),
}));
vi.mock("../../state/entities", () => ({
  readProjects: () => [],
  readThreadShells: () => [],
  useProjects: () => [],
  useServerConfigs: () =>
    new Map([["env-1", { environment: { capabilities: { threadSettlement: true } } }]]),
  useThreadShell: () => null,
  waitForThreadShell: () => Promise.resolve(true),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/forkSupervision", () => ({ useSupervisionMetadata: () => [] }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/threadResume", () => ({ resumeThreadFromPlan: "resumePlan" }));
vi.mock("../../state/projectIssues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/projectIssues")>()),
  decideProjectRequest: "decide",
  projectIssuesQuery: () => null,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { issues: mocks.issues } }),
}));
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
  ({ decide: mocks.decide, resumeQueue: mocks.resumeQueue }) as Record<
    string,
    ReturnType<typeof vi.fn> | undefined
  >;
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => commands()[command] ?? vi.fn(),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: string) => commands()[command] ?? vi.fn(),
}));
vi.mock("../orchestrators/useOrchestratorThreads", () => ({
  useOrchestratorThreadShells: () => mocks.shells,
}));
vi.mock("../orchestrators/ProjectRequestsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../orchestrators/ProjectRequestsSection")>()),
  useDiscuss: () => ({ start: vi.fn(), pending: null }),
}));

import { BlockerAnswersProvider } from "../blockers/BlockerAnswers";
import { WaitingBadge } from "../blockers/BlockerBadge";
import { DashboardView, type DashboardScope } from "./DashboardView";

const ENV = EnvironmentId.make("env-1");
const HEAD = ThreadId.make("head-thread");
const success = (value: unknown = {}) => ({ _tag: "Success", value });
const decode = Schema.decodeUnknownSync(DashboardSnapshot);

const task = (
  id: string,
  title: string,
  overrides: Partial<DashboardTask> = {},
): DashboardTask => ({
  id,
  sourceId: "gitea:git/o/r",
  closedAt: null,
  title,
  url: null,
  threadId: null,
  workstreamId: "ws",
  status: "blocked",
  progress: null,
  movement: {
    state: "unknown",
    doneDelta: null,
    windowMs: 3_600_000,
    fromAt: null,
    toAt: "2026-10-14T12:00:00.000Z",
  },
  forecast: null,
  nextStep: null,
  attentionIds: [],
  ...overrides,
});

function dataOf(tasks: ReadonlyArray<DashboardTask>, attention: ReadonlyArray<unknown> = []) {
  return {
    asOf: "2026-10-14T12:00:00.000Z",
    sources: [],
    releases: [],
    projects: [
      {
        key: `${ENV}:project`,
        environmentId: ENV,
        project: {
          id: "project",
          rootThreadId: HEAD,
          parentId: null,
          title: "Reliability",
          utility: false,
          omittedTaskCount: 0,
          workstreams: [{ id: "ws", title: "Server restarts", taskIds: tasks.map((t) => t.id) }],
          tasks,
          attention,
          sourceIds: [],
        },
      },
    ],
  };
}

function thread(
  id: string,
  title: string,
  options: { parent?: string; source?: Record<string, unknown> } = {},
): OrchestratorThreadShell {
  const base = makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: ENV,
    title,
    latestUserMessageAt: new Date().toISOString(),
  });
  return {
    ...presentThreadShell(ENV, { ...base.source, ...options.source } as never),
    parentThreadId: options.parent ? ThreadId.make(options.parent) : null,
    remoteParent: null,
    subproject: "auto" as const,
    purpose: null,
    supervisionMetadataPresent: true,
  } as OrchestratorThreadShell;
}

const HOME: DashboardScope = { kind: "home" };
const PROJECT: DashboardScope = { kind: "project", environmentId: ENV, threadId: HEAD };

let root: Root;
let container: HTMLDivElement;
const render = (node: ReactNode) => act(async () => root.render(node));
const popup = () => document.body.querySelector<HTMLElement>('[data-slot="popover-popup"]');
const blockedBadge = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Blocked: what holds"]');
const popupButton = (label: string) =>
  [...popup()!.querySelectorAll<HTMLButtonElement>("button")].find((element) =>
    element.textContent?.startsWith(label),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.issues = [];
  mocks.shells = [thread("head-thread", "Reliability head")];
  mocks.decide.mockResolvedValue(success({ notifiedThreadId: null, commentUrl: "http://git/c1" }));
  mocks.resumeQueue.mockResolvedValue(success());
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

describe("a blocked dashboard task names its blocker", () => {
  const heldLane = () =>
    thread("held-thread", "Dev server lane", {
      parent: "head-thread",
      source: { status: "queued", queueHeld: true },
    });

  it("names the thread a held queue is on and offers Resume queue, even when the row shows a next step", async () => {
    mocks.shells = [thread("head-thread", "Reliability head"), heldLane()];
    mocks.data = dataOf([
      task("local:t1", "Ship the lane", {
        threadId: ThreadId.make("held-thread"),
        nextStep: "Verify the fix",
      }),
    ]);
    await render(<DashboardView scope={PROJECT} />);
    // The next step still shows, and so does the badge beside it.
    expect(container.textContent).toContain("Verify the fix");
    expect(blockedBadge()).not.toBeNull();
    await act(async () => blockedBadge()!.click());
    expect(popup()!.textContent).toContain("Dev server lane");
    expect(popup()!.textContent).toContain("Queue held on Dev server lane.");
    expect(popup()!.textContent).not.toContain("Another issue holds this task");
    await act(async () => popupButton("Resume queue")!.click());
    expect(mocks.resumeQueue.mock.calls[0]![0]).toEqual({
      environmentId: ENV,
      input: { threadId: "held-thread" },
    });
    expect(popup()!.textContent).toContain("Queue resumed");
  });

  it("says a blocked task waits on a question and links the thread, instead of blaming another issue", async () => {
    mocks.shells = [
      thread("head-thread", "Reliability head"),
      thread("ask-thread", "Signing lane", { parent: "head-thread" }),
    ];
    mocks.data = dataOf([
      task("local:t2", "Sign the build", {
        threadId: ThreadId.make("ask-thread"),
        attentionIds: ["runtime:gone"],
      }),
    ]);
    await render(<DashboardView scope={PROJECT} />);
    await act(async () => blockedBadge()!.click());
    expect(popup()!.textContent).toContain("Waiting on a question in Signing lane");
    expect(popup()!.textContent).not.toContain("Another issue holds this task");
    const link = [...popup()!.querySelectorAll("button")].find(
      (element) => element.textContent === "Sign the build",
    );
    await act(async () => link!.click());
    expect(mocks.navigate.mock.calls.at(-1)![0].params).toMatchObject({ threadId: "ask-thread" });
  });

  it("names the issue that holds a task only when that issue is open", async () => {
    mocks.data = dataOf([task("issue:git.example/brad/fork#5", "Wire the badge")]);
    const issue = (number: number, extra: Partial<ProjectIssue> = {}) =>
      ({
        host: "git.example",
        repository: "brad/fork",
        number,
        title: `Task ${number}`,
        url: `https://git.example/brad/fork/issues/${number}`,
        status: "pending",
        labels: [],
        linkedThreadIds: [],
        closedAt: null,
        ...extra,
      }) as ProjectIssue;
    mocks.issues = [issue(5, { blockedBy: [9] }), issue(9)];
    await render(<DashboardView scope={PROJECT} />);
    await act(async () => blockedBadge()!.click());
    expect(popup()!.textContent).toContain("#9: Task 9");
    expect(popup()!.textContent).toContain("Waiting for #9 to close.");
  });

  it("says only that it is blocked when nothing names the cause", async () => {
    mocks.data = dataOf([task("local:t3", "Mystery task")]);
    await render(<DashboardView scope={PROJECT} />);
    await act(async () => blockedBadge()!.click());
    expect(popup()!.textContent).toContain("Open the task to inspect what is blocking it.");
    expect(popup()!.textContent).not.toContain("Another issue holds this task");
  });
});

describe("one answer per decision across the sidebar and the Dashboard", () => {
  const shells = [
    thread("product-head", "Product"),
    {
      ...thread("dashboard-head", "Dashboard", { parent: "product-head" }),
      subproject: "on" as const,
    },
  ].map((shell) => (shell.id === "product-head" ? { ...shell, subproject: "on" as const } : shell));

  const surfaces = () => {
    const snapshot = decode(projection);
    mocks.shells = shells;
    mocks.data = {
      ...dataOf([]),
      raw: snapshot,
      projects: snapshot.projects.map((project) => ({
        key: `${ENV}:${project.id}`,
        environmentId: ENV,
        project,
      })),
    };
    const summary = buildOrchestratorSummaries(shells as never, []).flatMap((row) => [
      row,
      ...row.subprojects,
    ]);
    const product = summary.find((row) => row.root.id === "product-head")!;
    return (
      <BlockerAnswersProvider>
        <div data-testid="sidebar">
          <WaitingBadge summary={product} fallbackCount={0} />
        </div>
        <div data-testid="dashboard">
          <DashboardView scope={HOME} />
        </div>
      </BlockerAnswersProvider>
    );
  };
  const inDashboard = () => container.querySelector('[data-testid="dashboard"]')!;

  it("shows the receipt on the Dashboard card once it is answered from the sidebar popover", async () => {
    await render(surfaces());
    const choice = () =>
      [...inDashboard().querySelectorAll("button")].filter((element) =>
        element.textContent?.startsWith("Buy a new certificate"),
      );
    expect(choice()).toHaveLength(1);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="sidebar"] button[aria-label^="Waiting"]')!
        .click(),
    );
    await act(async () =>
      [...popup()!.querySelectorAll("button")]
        .find((element) => element.textContent?.startsWith("and "))!
        .click(),
    );
    const sidebarChoice = [...popup()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.startsWith("Buy a new certificate"),
    )!;
    await act(async () => sidebarChoice.click());
    // One hold per decision: the Dashboard card cannot be answered a second time while it counts down.
    expect(choice()).toHaveLength(0);
    expect(inDashboard().textContent).toContain("Sending");
    // The Dashboard's copy of the receipt must not pull focus out of the popover that answered.
    expect(popup()).not.toBeNull();
    expect(popup()!.contains(document.activeElement)).toBe(true);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5050)));
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide.mock.calls[0]![0].input).toMatchObject({
      threadId: "product-head",
      decision: "option",
    });
  });
});
