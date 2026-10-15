// @vitest-environment jsdom
import { mergeDashboardSnapshots } from "@t3tools/client-runtime/dashboard/merge";
import { DashboardSnapshot, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { OpenTaskContext } from "../orchestrators/TaskLink";
import projection from "./fixtures/trackerPlanProjection.json";

const state = vi.hoisted(() => ({ data: null as unknown, now: 0 }));

// The data and router boundaries are replaced; DashboardView, VariantA, the plan rows and the chrome
// all run as shipped. The data is the recorded output of the server's production tracker pipeline
// (raw Gitea issues -> ProjectIssuesService -> aggregate -> schema encode/decode), merged by the
// real client-runtime merge: see fixtures/trackerPlanProjection.json "provenance".
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/liveRuntimeRequests", () => ({
  useLiveRuntimeRequests: () => ({ environments: new Set<string>(), pending: new Set<string>() }),
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
vi.mock("./useDecisionAnswers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useDecisionAnswers")>()),
  useDecisionAnswers: () => ({
    records: new Map(),
    stateOf: () => null,
    reconcile: () => undefined,
    strip: () => ({ text: "" }),
    receipt: () => "",
    draftOf: () => "",
    setDraft: () => undefined,
  }),
}));
vi.mock("./prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prefs")>()),
  useMinuteClock: () => state.now,
}));

import { DashboardView, type DashboardScope } from "./DashboardView";
import { hasStepList } from "./dashboard.logic";

const ENV = EnvironmentId.make("env-1");
const HEAD = ThreadId.make("pipeline-root");
const PROJECT: DashboardScope = { kind: "project", environmentId: ENV, threadId: HEAD };
const HOME: DashboardScope = { kind: "home" };
const decode = Schema.decodeUnknownSync(DashboardSnapshot);

type Key =
  | "t3"
  | "localController"
  | "constructed"
  | "constructedOmitted"
  | "constructedUnbound"
  | "constructedUnmatched";
const REAL_AT = "2026-10-14T07:00:00.000Z";
const BUILT_AT = "2026-10-14T10:00:00.000Z";

/** The recorded projection, decoded by the real schema and merged by the real runtime merge. */
function load(key: Key, edit?: (snapshot: DashboardSnapshot) => DashboardSnapshot) {
  const decoded = decode(projection[key]);
  return mergeDashboardSnapshots([
    { environmentId: ENV, snapshot: edit ? edit(decoded) : decoded },
  ]);
}

let root: Root;
let container: HTMLDivElement;

async function show(
  key: Key,
  at: string,
  edit?: (snapshot: DashboardSnapshot) => DashboardSnapshot,
  scope: DashboardScope = PROJECT,
) {
  state.data = load(key, edit);
  state.now = Date.parse(at);
  await act(() => root.render(<DashboardView scope={scope} />));
}
const snapshotOf = (key: Key) => decode(projection[key]);

const buttons = () => [...container.querySelectorAll("button")];
// A title is a button, or a plain heading when the epic has nothing to expand.
const titleButton = (text: string) =>
  [...container.querySelectorAll("button, span.line-clamp-3")].find((b) =>
    b.textContent?.includes(text),
  );
/** The grid row that holds a title button, its bar and its figure. */
const rowOf = (text: string) => {
  const button = titleButton(text);
  expect(button, `a row titled ${text}`).toBeDefined();
  return button!.closest("div")!;
};
const bars = (row: Element) => row.querySelectorAll('[role="img"]');
const expand = async (title: string) => {
  const row = rowOf(title);
  const caret = row.querySelector('button[aria-label="Expand"]');
  if (caret) await act(() => (caret as HTMLButtonElement).click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("workstream headers count child tasks (real T3 projection)", () => {
  it("shows an epic's done/total children with a child bar, not its task steps", async () => {
    await show("t3", REAL_AT);
    const row = rowOf("Dashboard roadmap");
    expect(row.textContent).toContain("10/20 tasks");
    expect(bars(row)[0]?.getAttribute("aria-label")).toBe("10 of 20 tasks");
  });

  it("shows a finished epic whose children are all closed as a heading with 6/6", async () => {
    await show("t3", REAL_AT);
    const row = rowOf("Port fork to upstream V2");
    expect(row.textContent).toContain("6/6 tasks");
  });

  it("nests a child epic under its parent and never adds it to the parent's figure", async () => {
    await show("t3", REAL_AT);
    const parent = rowOf("Dashboard roadmap").parentElement!;
    const nested = rowOf("Let projects have subprojects");
    // Inside the parent's block, with its own 4/5, while the parent keeps its 10/20.
    expect(parent.contains(nested)).toBe(true);
    expect(nested.textContent).toContain("4/5 tasks");
    expect(rowOf("Dashboard roadmap").textContent).not.toMatch(/14\/|\b9\/25\b/);
  });

  it("links a header to the epic's own waiting card", async () => {
    await show("t3", REAL_AT);
    // The epic task carries the decision; its header row is the only place that can show it.
    const link = [...rowOf("Make the dev fork update button").querySelectorAll("button")].find(
      (b) => b.textContent?.includes("waiting on you"),
    );
    expect(link).toBeDefined();
  });

  it("opens the epic from its #N reference", async () => {
    const opened: unknown[] = [];
    state.data = load("t3");
    state.now = Date.parse(REAL_AT);
    await act(() =>
      root.render(
        <OpenTaskContext value={(ref) => void opened.push(ref)}>
          <DashboardView scope={PROJECT} />
        </OpenTaskContext>,
      ),
    );
    const ref = buttons().find((b) => b.textContent === "#155");
    expect(ref).toBeDefined();
    await act(() => ref!.click());
    expect(opened).toEqual([{ host: "git.test", repository: "brad/t3code-fork", number: 155 }]);
  });
});

describe("task rows count personal steps (real T3 projection)", () => {
  it("shows a personal checklist as steps", async () => {
    await show("t3", REAL_AT);
    await expand("Unsorted");
    const row = rowOf("fork.7: update/reconnect");
    expect(row.textContent).toContain("1/13");
    expect(bars(row)[0]?.getAttribute("aria-label")).toBe("1 of 13 steps");
  });

  it("draws no bar and no 0/1 for an open task without a checklist, and says so", async () => {
    await show("t3", REAL_AT);
    await expand("Unsorted");
    const row = rowOf("Dashboard: active threads");
    expect(bars(row)).toHaveLength(0);
    expect(row.textContent).not.toMatch(/0\/1\b/);
    expect(row.textContent).toContain("no checklist yet");
  });

  it("does not turn checklist-less tasks into a project step total", async () => {
    await show("t3", REAL_AT);
    await expand("Unsorted");
    // Only 255 (0/4) and 223 (1/13) have checklists among the kept Unsorted tasks.
    const unsorted = rowOf("Unsorted");
    expect(unsorted.textContent).toContain("1/17");
    expect(unsorted.textContent).toMatch(/more tasks?/);
  });
});

describe("an epic with no children (real local-controller projection)", () => {
  it("is a heading with no measured bar and no 0/0", async () => {
    await show("localController", REAL_AT);
    const row = rowOf("Deploy hardware utilization monitoring");
    expect(bars(row)).toHaveLength(0);
    expect(row.textContent).not.toMatch(/0\/0|0\/1\b/);
  });
});

describe("constructed cases through the same pipeline", () => {
  it("renders an ETA as a calendar date, never a time", async () => {
    await show("constructed", BUILT_AT);
    await expand("Shipping the ledger");
    const row = rowOf("Write the export");
    expect(row.textContent).toContain("owner ETA Oct 20");
    expect(row.textContent).not.toMatch(/\d:\d\d|\b[ap]m\b/i);
  });

  it("leaves a row with no due date without any ETA", async () => {
    await show("constructed", BUILT_AT);
    await expand("Unsorted");
    expect(rowOf("A loose ask with a personal checklist").textContent).not.toMatch(/ETA/);
  });

  it("keeps a waiting-on-you link that opens the decision", async () => {
    await show("constructed", BUILT_AT);
    await expand("Shipping the ledger");
    const link = [...rowOf("Review the export").querySelectorAll("button")].find((b) =>
      b.textContent?.includes("waiting on you"),
    );
    expect(link).toBeDefined();
    await act(() => link!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("says plainly when a task's membership is in conflict", async () => {
    await show("constructed", BUILT_AT);
    await expand("Unsorted");
    expect(container.textContent).toMatch(/listed under several parent checklists/);
  });

  it("states how many workstreams the wire budget left out", async () => {
    const omitted = snapshotOf("constructedOmitted").projects[0]!.omittedWorkstreamCount ?? 0;
    expect(omitted).toBeGreaterThan(1);
    await show("constructedOmitted", BUILT_AT);
    expect(container.textContent).toContain(`+${omitted} more workstreams not in this snapshot`);
  });

  it("shows an empty epic beside measured ones with a heading only", async () => {
    await show("constructed", BUILT_AT);
    const empty = rowOf("Not started yet");
    expect(bars(empty)).toHaveLength(0);
    expect(empty.textContent).not.toMatch(/0\/0/);
    expect(rowOf("Shipping the ledger").textContent).toContain("1/4 tasks");
    expect(rowOf("Nested rollout").textContent).toContain("1/2 tasks");
  });
});

describe("unknown stays unknown", () => {
  const stale = (snapshot: DashboardSnapshot): DashboardSnapshot => ({
    ...snapshot,
    sources: [
      {
        id: "gitea:git.test/brad/t3code-fork",
        kind: "gitea",
        observedAt: REAL_AT,
        lastSuccessAt: "2026-10-14T03:00:00.000Z",
        staleAfterMs: 300_000,
        coverage: "complete",
        failed: false,
      },
    ],
    projects: snapshot.projects.map((project) => ({
      ...project,
      sourceIds: [...project.sourceIds, "gitea:git.test/brad/t3code-fork"],
    })),
  });

  it("marks a stale source's progress unknown without dating it from an unknown confirmation", async () => {
    await show("t3", REAL_AT, stale);
    await expand("Unsorted");
    const row = rowOf("fork.7: update/reconnect");
    expect(row.textContent).toContain("progress unknown");
    // confirmationKnown is false here: the epoch placeholder must never be shown as a date.
    expect(row.textContent).not.toMatch(/since (Jan 1|Dec 31)|1970/);
  });
});

describe("the project's plan source", () => {
  it("says once that old plan rows were dropped when the root moved to the tracker", async () => {
    await show("constructed", BUILT_AT, (snapshot) => ({
      ...snapshot,
      projects: snapshot.projects.map((project) => ({
        ...project,
        planMigration: { observedAt: BUILT_AT, removedTaskIds: ["plan:a", "plan:b", "plan:c"] },
      })),
    }));
    expect(container.textContent).toMatch(
      /3 rows? from the old plan file (is|are) no longer shown/,
    );
  });

  it("shows no such line for a project that has no migration problem", async () => {
    await show("constructed", BUILT_AT);
    expect(container.textContent).not.toMatch(/old plan file/);
  });

  it("keeps task-step headers for a server that predates every tracker field", async () => {
    // A real old payload: strip, from the raw JSON and before decoding, every field T2a added.
    const old = structuredClone(projection.constructed) as Record<string, any>;
    delete old.planMigration;
    for (const project of old.projects) {
      for (const field of ["planSource", "planMigration", "omittedWorkstreamCount"])
        delete project[field];
      for (const ws of project.workstreams)
        for (const field of [
          "membershipWarnings",
          "url",
          "threadId",
          "progress",
          "childIssueIds",
          "unknownChildIds",
          "parentWorkstreamId",
        ])
          delete ws[field];
      for (const task of project.tasks) {
        delete task.membershipWarnings;
        delete task.hasChecklist;
        if (task.forecast) delete task.forecast.precision;
        if (task.progress) delete task.progress.confirmationKnown;
      }
    }
    state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: decode(old) }]);
    state.now = Date.parse(BUILT_AT);
    await act(() => root.render(<DashboardView scope={PROJECT} />));
    const row = rowOf("Shipping the ledger");
    expect(row.textContent).not.toContain("tasks");
    expect(bars(row)[0]?.getAttribute("aria-label")).toMatch(/steps$/);
    expect(container.textContent).not.toMatch(/no checklist yet|Unbound|old plan file/);
  });
});

describe("migration warnings (amended server, contract v1.4)", () => {
  it("names a tracker briefing file that binds to no root, once, on Home", async () => {
    await show("constructedUnbound", BUILT_AT, undefined, HOME);
    const text = container.textContent ?? "";
    expect(text.match(/Unbound briefing file: t3-product\.json/g)).toHaveLength(1);
    expect(text).not.toMatch(/old plan file/);
  });

  it("shows nothing when the server reports no unbound file", async () => {
    await show("constructed", BUILT_AT, undefined, HOME);
    expect(container.textContent).not.toMatch(/Unbound briefing file/);
  });

  it("calls a truncated body what it is, not a membership problem", async () => {
    await show("constructed", BUILT_AT);
    await expand("Unsorted");
    const row = rowOf("A task whose body is far too long").parentElement!;
    expect(row.textContent).toContain("Plan body truncated");
    expect(container.textContent).not.toMatch(/Membership: truncated/);
  });
});

describe("a task's next action", () => {
  it("shows the latest note's next: text where there is no checklist, and still no bar", async () => {
    await show("constructed", BUILT_AT);
    await expand("Unsorted");
    const row = rowOf("Show live status while Update builds");
    expect(row.textContent).toContain("next: deploy 09:30Z");
    expect(bars(row)).toHaveLength(0);
    expect(row.textContent).not.toMatch(/0\/1\b/);
  });

  it("keeps the figure of a task that has a checklist", async () => {
    await show("constructed", BUILT_AT);
    await expand("Unsorted");
    const row = rowOf("A loose ask with a personal checklist");
    expect(row.textContent).toContain("1/2");
    expect(row.textContent).not.toContain("next:");
  });
});

describe("an epic is not an extra task on a project line", () => {
  // The T3 project as a subproject of another, so Home draws its single-line summary.
  const asSubproject = (): DashboardSnapshot => {
    const t3 = snapshotOf("t3");
    const parent = { ...snapshotOf("localController").projects[0]!, id: "project:parent" };
    return {
      ...t3,
      projects: [parent, { ...t3.projects[0]!, parentId: "project:parent" }],
    };
  };

  it("counts only real open tasks without a checklist", async () => {
    const t3 = snapshotOf("t3").projects[0]!;
    const epicIds = new Set(t3.workstreams.map((w) => w.id));
    // #271 and #171 are epics the snapshot keeps only for their waiting decision.
    expect(t3.tasks.filter((t) => epicIds.has(t.id)).length).toBeGreaterThanOrEqual(2);
    const expected = t3.tasks.filter(
      (t) => t.status !== "done" && !epicIds.has(t.id) && !hasStepList(t),
    ).length;
    state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: asSubproject() }]);
    state.now = Date.parse(REAL_AT);
    await act(() => root.render(<DashboardView scope={HOME} />));
    const row = rowOf("T3 Orchestrator");
    expect(row.textContent).toContain(`${expected} more tasks`);
  });
});

describe("an epic's own due date", () => {
  it("shows on its header as a date", async () => {
    await show("constructed", BUILT_AT);
    expect(rowOf("Rebuild the update path").textContent).toContain("owner ETA Oct 18");
  });
});

describe("headers and accessibility", () => {
  it("draws no bar and no 0/0 even if a server sent a zero-total progress", async () => {
    await show("constructed", BUILT_AT, (snapshot) => ({
      ...snapshot,
      projects: snapshot.projects.map((project) => ({
        ...project,
        workstreams: project.workstreams.map((ws) =>
          ws.title === "Not started yet"
            ? {
                ...ws,
                progress: {
                  done: 0,
                  total: 0,
                  planVersion: "v",
                  sourceId: "gitea:git.test/brad/repo",
                  confirmedAt: BUILT_AT,
                },
              }
            : ws,
        ),
      })),
    }));
    const row = rowOf("Not started yet");
    expect(bars(row)).toHaveLength(0);
    expect(row.textContent).not.toMatch(/0\/0/);
  });

  it("names the epic button for what it opens", async () => {
    await show("t3", REAL_AT);
    expect(container.querySelector('button[aria-label="Open issue #155"]')).not.toBeNull();
  });

  it("makes the title of an epic with nothing to expand a heading, not a button", async () => {
    await show("constructed", BUILT_AT);
    const title = titleButton("Not started yet");
    expect(title?.tagName).toBe("SPAN");
  });
});

describe("two unmatched briefing files (amended server)", () => {
  it("stay two separate head projects on Home, each with its own task", async () => {
    await show("constructedUnmatched", BUILT_AT, undefined, HOME);
    const names = [...container.querySelectorAll("button")]
      .map((b) => b.textContent)
      .filter((text) => text === "Day Planner" || text === "Print Cell");
    expect(names).toEqual(["Day Planner", "Print Cell"]);
    // Each head's task sits in its own block, never merged under one project.
    const block = (name: string) =>
      titleButton(name)!.closest("div.border-t") ?? titleButton(name)!.closest("div")!;
    expect(block("Day Planner").textContent).toContain("Plan the week in the briefing file");
    expect(block("Day Planner").textContent).not.toContain("Calibrate the second printer bed");
    expect(block("Print Cell").textContent).toContain("Calibrate the second printer bed");
    expect(container.textContent).not.toMatch(/Unbound briefing file/);
  });
});

describe("a subproject waiting on its only epic", () => {
  // The decision lives on the epic's own task, which the server keeps only for that reason.
  const edit = (): DashboardSnapshot => {
    const built = snapshotOf("constructed").projects[0]!;
    const epicId = built.workstreams.find((w) => w.title === "Rebuild the update path")!.id;
    const subproject = {
      ...built,
      parentId: "project:parent",
      tasks: built.tasks.filter((t) => t.id === epicId),
      workstreams: built.workstreams
        .filter((w) => w.id === epicId)
        .map((w) => ({ ...w, taskIds: [] })),
      attention: built.attention.filter((a) => a.taskId === epicId),
    };
    const parent = {
      ...snapshotOf("localController").projects[0]!,
      id: "project:parent",
      title: "Parent project",
      tasks: [],
      workstreams: [],
      attention: [],
    };
    return { ...snapshotOf("constructed"), projects: [parent, subproject] };
  };

  it("keeps its parent out of Idle and keeps the waiting link on the subproject line", async () => {
    state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: edit() }]);
    state.now = Date.parse(BUILT_AT);
    await act(() => root.render(<DashboardView scope={HOME} />));
    expect(container.textContent).not.toMatch(/Idle:/);
    const line = rowOf("Fixture project");
    expect(line.textContent).toContain("waiting on you");
    expect(line.textContent).not.toContain("no open work");
    // The epic is a header, not an open task, so the line does not count it.
    expect(line.textContent).not.toMatch(/more tasks?/);
  });
});

describe("a long next action", () => {
  const LONG = "next: rerun CI after the upstream sync, then deploy 09:30Z";

  it("wraps to two lines instead of cutting to one, so a time at the end is not lost", async () => {
    await show("constructed", BUILT_AT);
    await expand("Unsorted");
    const row = rowOf("Re-run CI after the upstream sync");
    // The tooltip trigger is the clamped span; the whole text is also in its popup.
    const clamped = [...row.querySelectorAll("span")].filter((el) => el.textContent === LONG);
    expect(clamped.some((el) => el.className.includes("line-clamp-2"))).toBe(true);
    expect(clamped.some((el) => /(^|\s)truncate(\s|$)/.test(el.className))).toBe(false);
  });
});

describe("the same unbound file reported by two environments", () => {
  it("is named once", async () => {
    state.data = mergeDashboardSnapshots([
      { environmentId: ENV, snapshot: snapshotOf("constructedUnbound") },
      { environmentId: EnvironmentId.make("env-2"), snapshot: snapshotOf("constructedUnbound") },
    ]);
    state.now = Date.parse(BUILT_AT);
    await act(() => root.render(<DashboardView scope={HOME} />));
    expect(container.textContent?.match(/Unbound briefing file: t3-product\.json/g)).toHaveLength(
      1,
    );
  });
});
