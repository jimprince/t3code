import { describe, expect, it } from "vite-plus/test";

import type { OrchestratorSummary } from "./orchestrators.ts";
import {
  projectKeyOf,
  subprojectCountLabel,
  subprojectIsActive,
  subprojectWorkingLabel,
  toggleProjectKey,
  topLevelProjects,
} from "./projectSubprojects.ts";

const summary = (
  id: string,
  options: { parent?: string; subprojects?: OrchestratorSummary[] } = {},
): OrchestratorSummary =>
  ({
    root: { environmentId: "env", id },
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
});
