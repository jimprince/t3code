import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping.ts";
import {
  pruneHiddenProjectKeys,
  resolveAllProjectsCheckboxState,
  resolveProjectScope,
  toggleAllHiddenProjectKeys,
  toggleHiddenProjectKey,
} from "./sidebarProjectScope.ts";

// Only the three fields the scope logic reads are populated. The full
// snapshot carries ~15 more fields that are irrelevant here, so the cast
// keeps the fixtures readable.
function projectGroup(
  projectKey: string,
  memberRefs: ReadonlyArray<readonly [string, string]> = [["env-1", projectKey]],
): SidebarProjectSnapshot {
  return {
    projectKey,
    displayName: projectKey,
    memberProjectRefs: memberRefs.map(([environmentId, projectId]) => ({
      environmentId,
      projectId,
    })),
  } as unknown as SidebarProjectSnapshot;
}

const groups = [projectGroup("alpha"), projectGroup("beta"), projectGroup("gamma")];

describe("toggleHiddenProjectKey", () => {
  it("hides a visible project", () => {
    expect(toggleHiddenProjectKey([], "beta")).toEqual(["beta"]);
  });

  it("shows a hidden project", () => {
    expect(toggleHiddenProjectKey(["beta", "gamma"], "beta")).toEqual(["gamma"]);
  });

  it("keeps the stored order sorted", () => {
    expect(toggleHiddenProjectKey(["gamma"], "alpha")).toEqual(["alpha", "gamma"]);
  });
});

describe("toggleAllHiddenProjectKeys", () => {
  it("hides every project when all are visible", () => {
    expect(toggleAllHiddenProjectKeys([], groups)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("hides every project when the selection is partial", () => {
    expect(toggleAllHiddenProjectKeys(["beta"], groups)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("shows every project when none are visible", () => {
    expect(toggleAllHiddenProjectKeys(["alpha", "beta", "gamma"], groups)).toEqual([]);
  });
});

describe("resolveAllProjectsCheckboxState", () => {
  it("is all when nothing is hidden", () => {
    expect(resolveAllProjectsCheckboxState([], groups)).toBe("all");
  });

  it("is partial when some are hidden", () => {
    expect(resolveAllProjectsCheckboxState(["beta"], groups)).toBe("partial");
  });

  it("is none when every project is hidden", () => {
    expect(resolveAllProjectsCheckboxState(["alpha", "beta", "gamma"], groups)).toBe("none");
  });

  it("is all for an empty project list", () => {
    expect(resolveAllProjectsCheckboxState([], [])).toBe("all");
  });
});

describe("pruneHiddenProjectKeys", () => {
  it("drops keys for projects that no longer exist", () => {
    expect(pruneHiddenProjectKeys(["beta", "deleted-project"], groups)).toEqual(["beta"]);
  });

  it("returns the same reference when nothing is stale", () => {
    const hidden = ["beta"];
    expect(pruneHiddenProjectKeys(hidden, groups)).toBe(hidden);
  });

  it("REGRESSION: never prunes against an empty project list", () => {
    // Projects load asynchronously. On the first render after a reload the
    // list is empty, and pruning then would wipe the persisted selection
    // before the projects it refers to have arrived.
    const hidden = ["beta"];
    expect(pruneHiddenProjectKeys(hidden, [])).toBe(hidden);
  });
});

describe("resolveProjectScope", () => {
  it("does not filter when everything is visible", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: [],
      isolatedProjectKey: null,
    });
    expect(scope.scopedProjectRefKeys).toBeNull();
    expect(scope.triggerLabel).toBe("All projects");
    expect(scope.allCheckboxState).toBe("all");
    expect(scope.isolatedProject).toBeNull();
  });

  it("labels and filters a partial selection", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: null,
    });
    expect(scope.triggerLabel).toBe("2 of 3 projects");
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha", "env-1:beta"]));
  });

  it("shows nothing when every project is deselected", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["alpha", "beta", "gamma"],
      isolatedProjectKey: null,
    });
    expect(scope.triggerLabel).toBe("No projects selected");
    expect(scope.scopedProjectRefKeys).toEqual(new Set());
  });

  it("expands every member ref of a grouped project", () => {
    const grouped = [
      projectGroup("alpha", [
        ["env-1", "alpha"],
        ["env-2", "alpha-remote"],
      ]),
      projectGroup("beta"),
    ];
    const scope = resolveProjectScope({
      projectGroups: grouped,
      hiddenProjectKeys: ["beta"],
      isolatedProjectKey: null,
    });
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha", "env-2:alpha-remote"]));
  });

  it("isolate overrides the selection", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: "alpha",
    });
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha"]));
    expect(scope.triggerLabel).toBe("alpha");
    expect(scope.isolatedProject?.projectKey).toBe("alpha");
  });

  it("isolates a project that is currently deselected", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: "gamma",
    });
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:gamma"]));
    expect(scope.triggerLabel).toBe("gamma");
  });

  it("ignores an isolate key whose project vanished", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: [],
      isolatedProjectKey: "deleted-project",
    });
    expect(scope.isolatedProject).toBeNull();
    expect(scope.scopedProjectRefKeys).toBeNull();
    expect(scope.triggerLabel).toBe("All projects");
  });

  it("REGRESSION: isolating never changes the checkbox state", () => {
    const hidden = ["gamma"];
    const isolated = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: hidden,
      isolatedProjectKey: "alpha",
    });
    // The checkbox row for gamma must still read "unchecked" while
    // isolated, and dropping isolate must restore the exact prior scope.
    expect(isolated.allCheckboxState).toBe("partial");
    expect(hidden).toEqual(["gamma"]);
    const restored = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: hidden,
      isolatedProjectKey: null,
    });
    expect(restored.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha", "env-1:beta"]));
  });

  it("changes settledResetKey whenever the effective scope changes", () => {
    const base = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: [],
      isolatedProjectKey: null,
    }).settledResetKey;
    const filtered = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: null,
    }).settledResetKey;
    const isolated = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: "alpha",
    }).settledResetKey;
    expect(new Set([base, filtered, isolated]).size).toBe(3);
  });

  it("keeps settledResetKey stable for an unchanged scope", () => {
    const input = {
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: null,
    } as const;
    expect(resolveProjectScope(input).settledResetKey).toBe(
      resolveProjectScope(input).settledResetKey,
    );
  });
});
