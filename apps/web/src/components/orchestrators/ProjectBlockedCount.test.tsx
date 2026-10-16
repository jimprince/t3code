// @vitest-environment jsdom
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildOrchestratorSummaries,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import { EnvironmentId, ThreadId, type ProjectIssue } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";

const mocks = vi.hoisted(() => ({
  issues: [] as ReadonlyArray<unknown>,
  active: [] as ReadonlyArray<string>,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/entities", () => ({
  readThreadShells: () => [],
  useServerConfigs: () =>
    new Map([
      [
        "dev",
        { environment: { capabilities: { threadSettlement: true, threadResumeFromPlan: true } } },
      ],
    ]),
  waitForThreadShell: () => Promise.resolve(true),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/threadLinks", () => ({
  resolveThreadLinkTarget: (environmentId: string, threadId: string) => ({
    environmentId,
    threadId,
  }),
}));
vi.mock("../../state/threadResume", () => ({ resumeThreadFromPlan: "resumePlan" }));
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
vi.mock("../../state/dashboard", () => ({
  useBlockerSnapshot: () => ({ snapshot: null, stored: false }),
  refreshDashboard: vi.fn(),
}));
vi.mock("../../state/liveRuntimeRequests", () => ({
  useLiveRuntimeRequests: () => ({ environments: new Set<string>(), threads: new Set<string>() }),
}));
vi.mock("../../state/projectIssues", () => ({ decideProjectRequest: "decide" }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useOrchestratorThreads", () => ({ useOrchestratorThreadShells: () => [] }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
// The page's task statuses are the one boundary replaced: which issues it loaded and which it shows Active.
vi.mock("./ProjectRequestsSection", () => ({
  useTaskStatuses: () => ({
    statuses: new Map(mocks.active.map((key) => [key, "active"])),
    query: { data: { issues: mocks.issues }, dataUpdatedAt: Date.now() },
  }),
}));

import { ProjectBlockedCount } from "./ProjectBlockedCount";

const DEV = EnvironmentId.make("dev");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function issue(number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    host: "git.example",
    repository: "brad/fork",
    number,
    title: `Task ${number}`,
    url: `https://git.example/brad/fork/issues/${number}`,
    status: "in-progress",
    labels: [],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: ago(10),
    updatedAt: ago(0),
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  };
}

function thread(
  id: string,
  title: string,
  options: { parent?: string; source?: Record<string, unknown> } = {},
): OrchestratorThreadShell {
  const base = makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: DEV,
    title,
    latestUserMessageAt: new Date().toISOString(),
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

const summaryOf = (...shells: OrchestratorThreadShell[]) =>
  buildOrchestratorSummaries(
    [{ ...thread("head", "Project head"), subproject: "on" as const }, ...shells],
    [],
  )[0]!;

let root: Root;
let container: HTMLDivElement;
const render = (summary: ReturnType<typeof summaryOf>) =>
  act(async () => root.render(<ProjectBlockedCount summary={summary} />));
const trigger = () => container.querySelector<HTMLButtonElement>("button")!;
const popup = () => document.body.querySelector<HTMLElement>('[data-slot="popover-popup"]');
const items = () => [...popup()!.querySelectorAll('[data-testid="blocker-item"]')];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.issues = [];
  mocks.active = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the project page's N blocked", () => {
  it("lists every task it counts, each named with its reason", async () => {
    // Two Active tasks untouched for four days and no failed worker: the old badge said "2 blocked"
    // over a popover that opened on "No thread is blocked".
    const quiet = [issue(11, { updatedAt: ago(4) }), issue(12, { updatedAt: ago(5) })];
    mocks.issues = quiet;
    mocks.active = quiet.map((item) => `${item.repository}#${item.number}`);
    await render(summaryOf());
    expect(trigger().textContent).toBe("2 blocked");
    await act(async () => trigger().click());
    expect(items()).toHaveLength(2);
    expect(popup()!.textContent).toContain("Task 11");
    expect(popup()!.textContent).toContain("Stuck 4d");
    expect(popup()!.textContent).toContain("Task 12");
    expect(popup()!.textContent).not.toContain("No thread is blocked");
  });

  it("names the open issue that holds a task, and counts a failed worker once beside it", async () => {
    const held = issue(5, { blockedBy: [9] });
    mocks.issues = [held, issue(9, { status: "pending" })];
    mocks.active = [`${held.repository}#5`];
    const failed = thread("retry", "v3-next-retired-r1", {
      parent: "head",
      source: { status: "failed", latestRunId: "run-1", lastError: "Model at capacity" },
    });
    await render(summaryOf(failed));
    expect(trigger().textContent).toBe("2 blocked");
    await act(async () => trigger().click());
    expect(items()).toHaveLength(2);
    expect(popup()!.textContent).toContain("Task 5");
    expect(popup()!.textContent).toContain("#9: Task 9");
    expect(popup()!.textContent).toContain("Model at capacity");
  });

  it("shows no badge when nothing is blocked", async () => {
    await render(summaryOf());
    expect(container.querySelector("button")).toBeNull();
  });
});
