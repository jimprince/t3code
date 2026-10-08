import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { describe, expect, it } from "vite-plus/test";

import {
  openTaskCount,
  ownTreeContains,
  projectTrail,
  subprojectIsActive,
  subprojectNeedsYou,
} from "./projectSubprojects.logic";

const issue = (number: number, state: "open" | "closed") =>
  ({
    host: "gitea.test",
    repository: "owner/repo",
    snapshot: { state },
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
  } = {},
): OrchestratorSummary =>
  ({
    root: { environmentId: "env", id },
    descendants: (options.workers ?? []).map((worker) => ({ environmentId: "env", id: worker })),
    subprojects: options.subprojects ?? [],
    parentProjectKey:
      options.parent === undefined || options.parent === null ? null : `env:${options.parent}`,
    issues: options.issues ?? [],
    rollup: { needsYou: options.needsYou ?? 0, working: 0, blocked: 0, latestActivityAt: "" },
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
});
