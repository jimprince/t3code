import { describe, expect, it } from "vite-plus/test";

import type { OrchestratorSummary } from "./orchestrators.ts";
import {
  isSettledProject,
  projectKeyOf,
  splitSettledSubprojects,
  subprojectCountLabel,
  subprojectIsActive,
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
    parent?: string;
    subprojects?: OrchestratorSummary[];
    issues?: OrchestratorSummary["issues"];
    settled?: boolean;
  } = {},
): OrchestratorSummary =>
  ({
    root: { environmentId: "env", id, settledOverride: options.settled ? "settled" : null },
    issues: options.issues ?? [],
    subprojects: options.subprojects ?? [],
    parentProjectKey: options.parent === undefined ? null : `env:${options.parent}`,
  }) as unknown as OrchestratorSummary;

describe("project subprojects", () => {
  it("lists only top-level projects, leaving subprojects to nest inside them", () => {
    const root = summary("root");
    const sub = summary("sub", { parent: "root" });
    expect(topLevelProjects([sub, root])).toEqual([root]);
    expect(projectKeyOf(root)).toBe("env:root");
  });

  it("hints how many subprojects a folded card hides, at any depth", () => {
    const nested = summary("nested");
    const sub = summary("sub", { subprojects: [nested] });
    expect(subprojectCountLabel(summary("root", { subprojects: [sub] }))).toBe("2 subs");
    expect(subprojectCountLabel(sub)).toBe("1 sub");
    expect(subprojectCountLabel(nested)).toBeNull();
  });

  it("says how much of the working count is inside subprojects", () => {
    const project = (working: number, own: number) =>
      ({ rollup: { working }, activeWorkerCount: own }) as unknown as OrchestratorSummary;
    expect(subprojectWorkingLabel(project(6, 4))).toBe("2 of 6 working in subprojects");
    expect(subprojectWorkingLabel(project(3, 0))).toBe("3 working in subprojects");
    expect(subprojectWorkingLabel(project(2, 2))).toBeNull();
    expect(subprojectWorkingLabel(project(0, 0))).toBeNull();
  });

  it("treats a subproject as active when only its own orchestrator is busy", () => {
    const withStatus = (status: string) =>
      ({ rollup: { working: 0 }, status }) as unknown as OrchestratorSummary;
    expect(subprojectIsActive(withStatus("ready"))).toBe(false);
    expect(subprojectIsActive(withStatus("supervising"))).toBe(true);
  });

  it("folds a project's subprojects away and back", () => {
    expect(toggleProjectKey([], "env:a")).toEqual(["env:a"]);
    expect(toggleProjectKey(["env:a", "env:b"], "env:a")).toEqual(["env:b"]);
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
});
