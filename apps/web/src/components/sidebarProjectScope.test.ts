import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping.ts";
import {
  pruneHiddenProjectKeys,
  resolveAllProjectsCheckboxState,
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
