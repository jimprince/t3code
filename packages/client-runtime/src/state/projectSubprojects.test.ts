import type { OrchestratorSummary } from "./orchestrators.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  openTaskCount,
  ownTreeContains,
  projectTrail,
  isSettledProject,
  labelWithTaskProgress,
  projectKeyOf,
  settledGroupSummary,
  splitSettledSubprojects,
  subprojectIsActive,
  subprojectNeedsYou,
  subprojectCountLabel,
  subprojectWorkingLabel,
  taskProgress,
  taskProgressComplete,
  taskProgressDescription,
  taskProgressFraction,
  toggleProjectKey,
  topLevelProjects,
} from "./projectSubprojects.ts";

const issue = (number: number, state: "open" | "closed" | null) =>
  ({
    host: "gitea.test",
    repository: "owner/repo",
    snapshot: state === null ? undefined : { state },
    number,
  }) as OrchestratorSummary["issues"][number];
const summary = (
  id: string,
  options: {
    parent?: string | null;
    issues?: OrchestratorSummary["issues"];
    subprojects?: OrchestratorSummary[];
    workers?: string[];
    needsYou?: number;
    settled?: boolean;
    blocked?: number;
  } = {},
): OrchestratorSummary =>
  ({
    root: { environmentId: "env", id, settledOverride: options.settled ? "settled" : null },
    descendants: (options.workers ?? []).map((worker) => ({ environmentId: "env", id: worker })),
    subprojects: options.subprojects ?? [],
    parentProjectKey:
      options.parent === undefined || options.parent === null ? null : `env:${options.parent}`,
    issues: options.issues ?? [],
    rollup: { needsYou: options.needsYou ?? 0, working: 0, blocked: options.blocked ?? 0, latestActivityAt: "" },
  }) as unknown as OrchestratorSummary;

describe("project subprojects", () => {
  it("counts open tasks across the project and its subprojects", () => {
    const nested = summary("nested", { issues: [issue(3, "open")] });
    const sub = summary("sub", {
      issues: [issue(2, "open"), issue(4, "closed")],
      subprojects: [nested],
    });
    const root = summary("root", { issues: [issue(1, "open")], subprojects: [sub] });
    expect(openTaskCount(root)).toBe(3);
    expect(openTaskCount(sub)).toBe(2);
  });

  it("counts an issue linked in both a project and its subproject once", () => {
    const sub = summary("sub", { issues: [issue(1, "open")] });
    const root = summary("root", { issues: [issue(1, "open")], subprojects: [sub] });
    expect(openTaskCount(root)).toBe(1);
  });

  it("treats a subproject as active when only its own orchestrator is busy", () => {
    const idle = { ...summary("idle"), status: "ready" } as OrchestratorSummary;
    const supervising = { ...summary("sup"), status: "supervising" } as OrchestratorSummary;
    expect(subprojectIsActive(idle)).toBe(false);
    expect(subprojectIsActive(supervising)).toBe(true);
  });

  it("selects a project only for threads in its own tree, not a subproject's", () => {
    const root = summary("root", { workers: ["worker"] });
    expect(ownTreeContains(root, "env:worker")).toBe(true);
    expect(ownTreeContains(root, "env:sub-worker")).toBe(false);
    expect(ownTreeContains(root, null)).toBe(false);
  });

  it("lists enclosing projects outermost first and ends at a top-level project", () => {
    const root = summary("root");
    const mid = summary("mid", { parent: "root" });
    const deep = summary("deep", { parent: "mid" });
    expect(projectTrail([deep, mid, root], deep).map((item) => item.root.id)).toEqual([
      "root",
      "mid",
    ]);
    expect(projectTrail([deep, mid, root], root)).toEqual([]);
  });

  it("does not loop when parent links form a cycle", () => {
    const a = summary("a", { parent: "b" });
    const b = summary("b", { parent: "a" });
    expect(projectTrail([a, b], a).map((item) => item.root.id)).toEqual(["b"]);
  });

  it("sums what is waiting inside direct subprojects' rollups", () => {
    const root = summary("root", {
      subprojects: [summary("a", { needsYou: 2 }), summary("b", { needsYou: 1 })],
    });
    expect(subprojectNeedsYou(root)).toBe(3);
  });

  it("folds a project's subprojects away and back", () => {
    expect(toggleProjectKey([], "env:a")).toEqual(["env:a"]);
    expect(toggleProjectKey(["env:a", "env:b"], "env:a")).toEqual(["env:b"]);
  });

  it("leaves settled subprojects, and what is beneath them, out of the fold hint", () => {
    const beneath = summary("beneath");
    const retired = summary("retired", { settled: true, subprojects: [beneath] });
    const live = summary("live");
    expect(subprojectCountLabel(summary("root", { subprojects: [retired, live] }))).toBe("1 sub");
    expect(subprojectCountLabel(summary("only-settled", { subprojects: [retired] }))).toBeNull();
  });

  it("says how much of the working count is inside subprojects", () => {
    const project = (working: number, own: number) =>
      ({ rollup: { working }, activeWorkerCount: own }) as unknown as OrchestratorSummary;
    expect(subprojectWorkingLabel(project(6, 4))).toBe("2 of 6 working in subprojects");
    expect(subprojectWorkingLabel(project(3, 0))).toBe("3 working in subprojects");
    expect(subprojectWorkingLabel(project(2, 2))).toBeNull();
    expect(subprojectWorkingLabel(project(0, 0))).toBeNull();
  });

  it("hints how many subprojects a folded card hides, at any depth", () => {
    const nested = summary("nested");
    const sub = summary("sub", { subprojects: [nested] });
    expect(subprojectCountLabel(summary("root", { subprojects: [sub] }))).toBe("2 subs");
    expect(subprojectCountLabel(sub)).toBe("1 sub");
    expect(subprojectCountLabel(nested)).toBeNull();
  });

  it("lists only top-level projects, leaving subprojects to nest inside them", () => {
    const root = summary("root");
    const sub = summary("sub", { parent: "root" });
    expect(topLevelProjects([sub, root])).toEqual([root]);
  });

  it("splits settled subprojects from the inline ones, keeping order", () => {
    const a = summary("a");
    const b = summary("b", { settled: true });
    const c = summary("c");
    const split = splitSettledSubprojects([a, b, c]);
    expect(split.active).toEqual([a, c]);
    expect(split.settled).toEqual([b]);
    expect(isSettledProject(b)).toBe(true);
    expect(isSettledProject(a)).toBe(false);
  });

  describe("task progress", () => {
    it("counts closed of linked tasks over the project and its subprojects", () => {
      const nested = summary("nested", { issues: [issue(3, "open")] });
      const sub = summary("sub", {
        issues: [issue(2, "closed"), issue(4, "closed")],
        subprojects: [nested],
      });
      const root = summary("root", { issues: [issue(1, "open")], subprojects: [sub] });
      expect(taskProgress(root)).toEqual({ done: 2, total: 4, unknown: 0 });
      expect(taskProgress(sub)).toEqual({ done: 2, total: 3, unknown: 0 });
      expect(taskProgress(nested)).toEqual({ done: 0, total: 1, unknown: 0 });
    });

    it("drops settled subprojects, and everything beneath them, from both numbers", () => {
      const beneath = summary("beneath", { issues: [issue(9, "open")] });
      const retired = summary("retired", {
        settled: true,
        issues: [issue(5, "open"), issue(6, "open")],
        subprojects: [beneath],
      });
      const live = summary("live", { issues: [issue(2, "closed")] });
      const root = summary("root", { issues: [issue(1, "closed")], subprojects: [retired, live] });
      expect(taskProgress(root)).toEqual({ done: 2, total: 2, unknown: 0 });
      // A row listed inside the Settled group still tallies its own scope.
      expect(taskProgress(retired)).toEqual({ done: 0, total: 3, unknown: 0 });
    });

    it("counts an issue linked twice once, open when any link says open", () => {
      const sub = summary("sub", { issues: [issue(1, "closed"), issue(2, "closed")] });
      const root = summary("root", {
        issues: [issue(1, "open"), issue(2, "closed")],
        subprojects: [sub],
      });
      expect(taskProgress(root)).toEqual({ done: 1, total: 2, unknown: 0 });
      const closedFirst = summary("closed-first", {
        issues: [issue(1, "closed"), issue(2, "closed")],
        subprojects: [summary("open-later", { issues: [issue(1, "open")] })],
      });
      expect(taskProgress(closedFirst)).toEqual({ done: 1, total: 2, unknown: 0 });
    });

    it("leaves an issue with no snapshot out of both numbers", () => {
      const root = summary("root", {
        issues: [issue(1, "closed"), issue(2, null), issue(3, "open")],
      });
      expect(taskProgress(root)).toEqual({ done: 1, total: 2, unknown: 1 });
      // Another link that does know the state settles it.
      const sub = summary("sub", { issues: [issue(2, "closed")] });
      const joined = summary("joined", { issues: [issue(2, null)], subprojects: [sub] });
      expect(taskProgress(joined)).toEqual({ done: 1, total: 1, unknown: 0 });
    });

    it("shows nothing for a project without known tasks", () => {
      expect(taskProgressFraction(taskProgress(summary("none")))).toBeNull();
      expect(taskProgressDescription(taskProgress(summary("none")))).toBeNull();
      const unknownOnly = summary("unknown", { issues: [issue(1, null)] });
      expect(taskProgressFraction(taskProgress(unknownOnly))).toBeNull();
      expect(taskProgressComplete(taskProgress(unknownOnly))).toBe(false);
    });

    it("formats the compact fraction and its label, and flags a finished project", () => {
      const open = taskProgress(summary("p", { issues: [issue(1, "closed"), issue(2, "open")] }));
      expect(taskProgressFraction(open)).toBe("1/2");
      expect(taskProgressDescription(open)).toBe("1 of 2 tasks done");
      expect(taskProgressComplete(open)).toBe(false);
      const done = taskProgress(summary("q", { issues: [issue(1, "closed")] }));
      expect(taskProgressFraction(done)).toBe("1/1");
      expect(taskProgressComplete(done)).toBe(true);
    });
  });

  describe("settled group", () => {
    it("counts the settled subprojects with no warning when nothing waits", () => {
      const group = settledGroupSummary([summary("a"), summary("b")]);
      expect(group).toEqual({
        label: "Settled (2)",
        attention: false,
        description: "2 settled subprojects",
      });
      expect(settledGroupSummary([summary("a")]).description).toBe("1 settled subproject");
    });

    it("surfaces what needs you or is blocked inside the settled subprojects", () => {
      const waiting = settledGroupSummary([
        summary("a", { needsYou: 1 }),
        summary("b", { needsYou: 2, blocked: 1 }),
        summary("c"),
      ]);
      expect(waiting.label).toBe("Settled (3) · 3 need you · 1 blocked");
      expect(waiting.attention).toBe(true);
      expect(waiting.description).toBe("3 settled subprojects, 3 need you, 1 blocked");
    });
  });

  it("appends the task progress to a row's accessible label", () => {
    const tasks = summary("p", { issues: [issue(1, "closed"), issue(2, "open")] });
    expect(labelWithTaskProgress("Open P subproject", tasks)).toBe(
      "Open P subproject, 1 of 2 tasks done",
    );
    expect(labelWithTaskProgress("Open P subproject", summary("none"))).toBe("Open P subproject");
  });
});
