// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type DashboardTask } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ data: null as unknown }));

// The data and router boundaries are replaced; DashboardView, VariantA, the plan rows and the chrome
// all run as shipped.
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
  useServerConfigs: () => new Map(),
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
  }),
}));

import { DashboardView, type DashboardScope } from "./DashboardView";

const ENV = EnvironmentId.make("env-1");
const HEAD = ThreadId.make("head-thread");
const LONG_TITLE =
  "A session stuck in 'starting' after the server restarts keeps the whole project blocked";

const task = (id: string, title: string): DashboardTask => ({
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
});

function snapshot(tasks: ReadonlyArray<DashboardTask>) {
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
          attention: [],
          sourceIds: [],
        },
      },
    ],
  };
}

const HOME: DashboardScope = { kind: "home" };
const PROJECT: DashboardScope = { kind: "project", environmentId: ENV, threadId: HEAD };

let root: Root;
let container: HTMLDivElement;

async function render(scope: DashboardScope) {
  await act(() => root.render(<DashboardView scope={scope} />));
}

const section = (name: string) =>
  container.querySelector(`[data-testid="dashboard-section-${name}"]`);
const taskTitle = (text: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  state.data = snapshot([task("issue:git/o/r#1", LONG_TITLE)]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("the Dashboard has one design", () => {
  it.each([
    ["Home", HOME],
    ["a project page", PROJECT],
  ])("renders the Plan board and no design picker on %s", async (_name, scope) => {
    await render(scope);
    expect(section("plan")).not.toBeNull();
    expect(section("decisions")).not.toBeNull();
    expect(container.querySelector('[aria-label="Dashboard design"]')).toBeNull();
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    for (const variant of ["A", "B", "C", "Previous"]) expect(labels).not.toContain(variant);
  });

  it.each(['"B"', '"C"', '"previous"', '"A"', "not json"])(
    "a stored design of %s still renders the Plan board and is not read",
    async (stored) => {
      window.localStorage.setItem("t3.dashboard.variant", stored);
      await render(PROJECT);
      expect(section("plan")).not.toBeNull();
      expect(section("decisions")).not.toBeNull();
      expect(container.querySelector('[aria-label="Dashboard design"]')).toBeNull();
      // Nothing rewrites the old preference either.
      expect(window.localStorage.getItem("t3.dashboard.variant")).toBe(stored);
    },
  );
});

describe("a long plan title", () => {
  it.each([
    ["Home", HOME],
    ["the project page", PROJECT],
  ])("is rendered whole and wraps instead of ending in an ellipsis on %s", async (_name, scope) => {
    await render(scope);
    const title = taskTitle(LONG_TITLE);
    expect(title).toBeDefined();
    // The full text is in the DOM, it wraps to at most three lines, and nothing cuts it to one line.
    expect(title!.textContent).toContain(LONG_TITLE);
    expect(title!.className).toContain("line-clamp-3");
    expect(title!.className).not.toMatch(/(^|\s)truncate(\s|$)/);
  });

  it("gives the title column all the width the fixed bar and status columns leave", async () => {
    await render(HOME);
    const row = taskTitle(LONG_TITLE)!.parentElement!;
    expect(row.className).toContain("minmax(120px,1fr)_96px_minmax(110px,auto)");
  });
});
