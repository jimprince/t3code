import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGeneralChatSidebarSnapshot,
  buildSidebarProjectSnapshots,
  GENERAL_CHAT_PROJECT_KEY,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping.ts";
import type { Project } from "../types.ts";
import {
  isolateProjectKey,
  pruneHiddenProjectKeys,
  resolveAllProjectsCheckboxState,
  resolveIsolatedProjectKey,
  resolveVisibleProjectRefKeys,
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

  it("REGRESSION: shows every project when the selection is partial", () => {
    // "All projects" is the way back from a filtered list. Hiding everything
    // from a partial selection left an empty sidebar instead.
    expect(toggleAllHiddenProjectKeys(["beta"], groups)).toEqual([]);
  });

  it("shows every project when none are visible", () => {
    expect(toggleAllHiddenProjectKeys(["alpha", "beta", "gamma"], groups)).toEqual([]);
  });
});

describe("isolateProjectKey", () => {
  it("leaves only the clicked project visible", () => {
    expect(isolateProjectKey([], groups, "beta")).toEqual(["alpha", "gamma"]);
  });

  it("replaces an earlier partial selection", () => {
    expect(isolateProjectKey(["alpha"], groups, "gamma")).toEqual(["alpha", "beta"]);
  });

  it("brings every project back when the clicked project is already alone", () => {
    expect(isolateProjectKey(["alpha", "gamma"], groups, "beta")).toEqual([]);
  });
});

describe("resolveIsolatedProjectKey", () => {
  it("names the only visible project", () => {
    expect(resolveIsolatedProjectKey(["alpha", "gamma"], groups)).toBe("beta");
  });

  it("is null when several projects are visible", () => {
    expect(resolveIsolatedProjectKey(["alpha"], groups)).toBeNull();
  });

  it("is null for a single-project catalog, which has nothing to filter", () => {
    expect(resolveIsolatedProjectKey([], [projectGroup("alpha")])).toBeNull();
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

describe("resolveVisibleProjectRefKeys", () => {
  const environmentId = EnvironmentId.make("env-1");
  const makeProject = (id: string, kind: "chat" | "workspace"): Project => ({
    id: ProjectId.make(id),
    environmentId,
    kind,
    title: id,
    workspaceRoot: `/tmp/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  });
  // The sidebar's filter list: General chat first, then workspace projects.
  const chat = buildGeneralChatSidebarSnapshot({
    projects: [makeProject("chat", "chat")],
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: () => null,
  })!;
  const filterGroups = [
    chat,
    ...buildSidebarProjectSnapshots({
      projects: [makeProject("job", "workspace"), makeProject("printcell", "workspace")],
      settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: environmentId,
      resolveEnvironmentLabel: () => null,
    }),
  ];
  const jobKey = filterGroups.find((group) => group.displayName === "job")!.projectKey;

  it("is null when nothing is hidden", () => {
    expect(resolveVisibleProjectRefKeys([], filterGroups)).toBeNull();
  });

  it("REGRESSION: General chat threads do not pass a filter to one project", () => {
    // General chat used to bypass the filter, so its threads showed in every
    // filtered list. It is now an ordinary entry that hides like the rest.
    const visible = resolveVisibleProjectRefKeys(
      isolateProjectKey([], filterGroups, jobKey),
      filterGroups,
    );
    expect(visible).toEqual(new Set(["env-1:job"]));
  });

  it("filters to General chat alone", () => {
    const visible = resolveVisibleProjectRefKeys(
      isolateProjectKey([], filterGroups, GENERAL_CHAT_PROJECT_KEY),
      filterGroups,
    );
    expect(visible).toEqual(new Set(["env-1:chat"]));
  });
});
