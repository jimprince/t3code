// @vitest-environment jsdom
import { mergeDashboardSnapshots } from "@t3tools/client-runtime/dashboard/merge";
import {
  DashboardSnapshot,
  EnvironmentId,
  ThreadId,
  type DashboardTask,
  type DashboardWorkstream,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  data: null as unknown,
  now: 0,
  capable: true,
  failNext: false,
  calls: [] as Array<{ command: string; value: Record<string, unknown> }>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/dashboard", () => ({
  useDashboardData: () => ({
    data: state.data,
    revision: 1,
    failed: false,
    retry: undefined,
    olderEnvironments: [],
    snapshotSource: "live",
  }),
}));
vi.mock("../../state/entities", () => ({
  readProjects: () => [],
  readThreadShells: () => [],
  useProjects: () => [],
  useServerConfigs: () =>
    state.capable
      ? new Map([["env-1", { environment: { capabilities: { projectRequestOrder: true } } }]])
      : new Map(),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/forkSupervision", () => ({ useSupervisionMetadata: () => [] }));
vi.mock("../orchestrators/useOrchestratorThreads", () => ({
  useOrchestratorThreadShells: () => [],
}));
vi.mock("./useDecisionAnswers", () => ({
  useDecisionAnswers: () => ({
    records: new Map(),
    stateOf: () => null,
    reconcile: () => undefined,
    strip: () => ({ text: "" }),
  }),
}));
vi.mock("./prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prefs")>()),
  useMinuteClock: () => state.now,
}));
// Every command records what the page asked the server and succeeds.
vi.mock("../../state/projectIssues", () => ({
  orderProjectRequest: { label: "order" },
  updateProjectRequest: { label: "update" },
  fileProjectRequest: { label: "file" },
  settleProjectRequest: { label: "settle" },
}));
vi.mock("../../state/projectRoadmap", () => ({ moveRoadmapItem: { label: "later" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => (value: { input: Record<string, unknown> }) => {
    state.calls.push({ command: command.label, value: value.input });
    if (state.failNext) {
      state.failNext = false;
      return Promise.resolve(AsyncResult.failure(Cause.fail(new Error("Gitea is down"))));
    }
    return Promise.resolve({
      _tag: "Success",
      value:
        command.label === "file"
          ? {
              request: { host: "git.test", repository: "brad/repo", number: 312, url: "u" },
              queued: false,
              notifiedThreadId: null,
            }
          : { position: 1, rank: 1, workstream: null },
    });
  },
}));

import { DashboardView } from "./DashboardView";

const ENV = EnvironmentId.make("env-1");
const HEAD = ThreadId.make("root");
const NOW = "2026-10-14T12:00:00.000Z";
const decode = Schema.decodeUnknownSync(DashboardSnapshot);
const id = (n: number) => `issue:git.test/brad/repo#${n}`;
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

const task = (n: number, extra: Partial<DashboardTask> = {}) =>
  ({
    id: id(n),
    sourceId: "gitea:git.test/brad/repo",
    title: `Task ${n}`,
    url: null,
    threadId: null,
    workstreamId: "project:root:work",
    kind: "task",
    createdAt: ago(48),
    closedAt: null,
    status: "pending",
    progress: null,
    movement: { state: "unknown", doneDelta: null, windowMs: 0, fromAt: null, toAt: NOW },
    forecast: null,
    nextStep: null,
    attentionIds: [],
    ...extra,
  }) satisfies DashboardTask;
const epic = (n: number, taskIds: string[], extra: Partial<DashboardWorkstream> = {}) => ({
  id: id(n),
  title: `Epic ${n}`,
  url: `https://git.test/${n}`,
  taskIds,
  rank: n,
  ...extra,
});

function snapshot() {
  const tasks = [
    task(294, { workstreamId: id(300), partOf: 300, status: "working", rank: 10 }),
    task(295, { workstreamId: id(300), partOf: 300, rank: 100 }),
    task(296, { workstreamId: id(300), partOf: 300, rank: 200 }),
    task(282, { rank: 50 }),
    task(310, { createdAt: ago(1), placedBy: null }),
    task(311, { createdAt: ago(6) }),
  ];
  return decode({
    revision: 1,
    asOf: NOW,
    sources: [],
    releases: [],
    projects: [
      {
        planSource: "tracker",
        id: "project:root",
        rootThreadId: HEAD,
        parentId: null,
        title: "T3 Code",
        utility: false,
        omittedTaskCount: 0,
        workstreams: [
          epic(300, [id(294), id(295), id(296)]),
          { id: "project:root:work", title: "Unsorted", taskIds: [id(282), id(310), id(311)] },
        ],
        tasks,
        attention: [],
        sourceIds: [],
      },
    ],
  });
}

let root: Root;
let container: HTMLDivElement;

async function show() {
  state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: snapshot() }]);
  state.now = Date.parse(NOW);
  await act(() =>
    root.render(<DashboardView scope={{ kind: "project", environmentId: ENV, threadId: HEAD }} />),
  );
}
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const field = () => container.querySelector("textarea")!;
async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const press = (target: Element, init: KeyboardEventInit) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  state.calls = [];
  state.capable = true;
  state.failNext = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("New, not ordered", () => {
  it("lists unranked asks newest first and marks only those filed in the last four hours", async () => {
    await show();
    const rows = [...container.querySelectorAll('[data-testid="new-row"]')];
    expect(rows.map((row) => /#(\d{3})/.exec(row.textContent!)![1])).toEqual(["310", "311"]);
    expect(rows[0]!.querySelector('[data-testid="new-mark"]')?.getAttribute("aria-label")).toBe(
      "New, not placed yet",
    );
    expect(rows[1]!.querySelector('[data-testid="new-mark"]')).toBeNull();
  });

  it("names who placed an item that is already in the queue", async () => {
    state.capable = true;
    const original = snapshot();
    const edited = {
      ...original,
      projects: original.projects.map((project) => ({
        ...project,
        tasks: project.tasks.map((t) =>
          t.id === id(295)
            ? { ...t, createdAt: ago(1), placedBy: { kind: "agent" as const, name: "Product" } }
            : t,
        ),
      })),
    };
    state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: edited }]);
    state.now = Date.parse(NOW);
    await act(() =>
      root.render(
        <DashboardView scope={{ kind: "project", environmentId: ENV, threadId: HEAD }} />,
      ),
    );
    const marks = [...container.querySelectorAll('[data-testid="new-mark"]')].map((m) =>
      m.getAttribute("aria-label"),
    );
    expect(marks).toContain("New, placed by Product");
  });

  it("Do next asks the server to place the item at the top, as Brad", async () => {
    await show();
    await act(async () => button("Do next").click());
    expect(state.calls).toEqual([
      {
        command: "order",
        value: { threadId: HEAD, reference: "310", place: { to: "top" }, actor: "brad" },
      },
    ]);
    expect(text()).toContain("Saved: #310 is 1st in Other work.");
  });

  it("does not show without the server capability", async () => {
    state.capable = false;
    await show();
    expect(container.querySelector('[data-testid="new-block"]')).toBeNull();
    expect(container.querySelector('[data-testid="dashboard-request-line"]')).toBeNull();
    expect(container.querySelector('[data-testid="queued-row"]')).toBeNull();
  });
});

describe("the ordered Plan", () => {
  it("numbers queued rows from 1 and leaves started work unnumbered above them", async () => {
    await show();
    const queued = [...container.querySelectorAll('[data-testid="queued-row"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(queued).toEqual(["1. Task 295", "2. Task 296", "1. Task 282"]);
    expect(text()).toContain("Next, in order");
    expect(text().indexOf("Task 294")).toBeLessThan(text().indexOf("Task 295"));
  });

  it("Alt+Down moves the focused row after its neighbour", async () => {
    await show();
    const row = container.querySelector('[data-testid="queued-row"]')!;
    await press(row, { key: "ArrowDown", altKey: true });
    expect(state.calls[0]).toEqual({
      command: "order",
      value: {
        threadId: HEAD,
        reference: "295",
        place: { to: "after", reference: "296" },
        actor: "brad",
      },
    });
  });

  it("N does a focused row next within its workstream", async () => {
    await show();
    const row = container.querySelectorAll('[data-testid="queued-row"]')[1]!;
    await press(row, { key: "n" });
    expect(state.calls[0]!.value).toMatchObject({ reference: "296", place: { to: "top" } });
  });
});

describe("the request line", () => {
  it("Enter files last and Cmd+Enter files next, with Brad's words and actor", async () => {
    await show();
    await type("Widen the plan");
    await press(field(), { key: "Enter" });
    await type("Narrow the plan");
    await press(field(), { key: "Enter", metaKey: true });
    const filings = state.calls.filter((call) => call.command === "file");
    expect(filings.map((call) => call.value.place)).toEqual([{ to: "bottom" }, { to: "top" }]);
    expect(filings[0]!.value).toMatchObject({
      threadId: HEAD,
      title: "Widen the plan",
      kind: "task",
      actor: "brad",
    });
    expect(text()).toContain("Filed #312 task, next in Other work.");
  });

  it("selects Bug from a Bug: lead and keeps the words", async () => {
    await show();
    await type("Bug: the drag drops one row up");
    await press(field(), { key: "Enter" });
    expect(state.calls[0]!.value).toMatchObject({
      title: "Bug: the drag drops one row up",
      bug: true,
      kind: "task",
    });
  });

  it("files into the chosen workstream", async () => {
    await show();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Workstream"]')!;
    await act(async () => {
      select.value = "300";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type("Add a thing");
    await press(field(), { key: "Enter" });
    expect(state.calls[0]!.value).toMatchObject({ partOf: 300 });
  });

  it("keeps the words and says why when the filing fails, then retries the same filing", async () => {
    await show();
    await type("Do not lose me");
    state.failNext = true;
    await press(field(), { key: "Enter" });
    expect(field().value).toBe("Do not lose me");
    expect(text()).toContain("Not filed: Gitea is down");
    await press(field(), { key: "Enter" });
    const [first, second] = state.calls.filter((call) => call.command === "file");
    expect(second!.value.messageId).toBe(first!.value.messageId);
    expect(field().value).toBe("");
  });
});
