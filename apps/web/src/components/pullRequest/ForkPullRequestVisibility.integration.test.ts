import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => enqueue }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { runAction: {} } }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({}),
  useEnvironmentSettings: () => null,
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => null }));
vi.mock("~/lib/sourceControlActions", () => ({ usePreparePullRequestThreadAction: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { assignProjectsToEnvironments } from "./pullRequestProjectAssignment.logic";
import { useLocalPrVisibility } from "./localPrVisibility";
import { usePullRequestActionRunner, usePullRequestCloseBatch } from "./usePullRequestActions";
import {
  applyPullRequestOverrides,
  pullRequestEntryKey,
  pullRequestOverrideAfterAction,
  type EnvironmentPullRequestEntry,
} from "./pullRequestList.logic";

const env = EnvironmentId.make("env-1");
const other = EnvironmentId.make("env-2");
const environments = [env, other];
let scopedProjectId: ProjectId | undefined;
const row: EnvironmentPullRequestEntry = {
  environmentId: env,
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  provider: "github",
  host: "github.com",
  repository: "acme/repo",
  number: 1,
  title: "First",
  url: "https://github.com/acme/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  headBranch: "feature",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
  viewerReviewRequested: false,
  labels: [],
};
let renderer: ReactTestRenderer | undefined;
let visibility: ReturnType<typeof useLocalPrVisibility>;
let native: ReturnType<typeof usePullRequestActionRunner>;
let batch: ReturnType<typeof usePullRequestCloseBatch>;
function Surface() {
  visibility = useLocalPrVisibility(environments, scopedProjectId);
  native = usePullRequestActionRunner({ environmentId: env, reference: row });
  batch = usePullRequestCloseBatch(() => {});
  return null;
}
function mount() {
  act(() => {
    renderer = create(createElement(Surface));
  });
}
beforeEach(() => {
  scopedProjectId = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  enqueue.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  mount();
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("fork local visibility with native action paths", () => {
  it("dismisses and restores across restart without provider actions; native actions still enqueue", async () => {
    act(() => visibility.select([pullRequestEntryKey(row)], true));
    act(() => visibility.dismiss([row]));
    expect(visibility.filter([row, { ...row, environmentId: other }])).toEqual([
      { ...row, environmentId: other },
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    act(() => renderer?.unmount());
    mount();
    expect(visibility.filter([row])).toEqual([]);
    act(() => visibility.restore());
    expect(visibility.filter([row])).toEqual([row]);
    expect(enqueue).not.toHaveBeenCalled();
    await act(async () => native.perform("close"));
    expect(enqueue).toHaveBeenCalledWith({
      environmentId: env,
      input: expect.objectContaining({ action: "close", number: 1 }),
    });
    await act(async () => batch.close([row, { ...row, number: 2 }]));
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
  it("filters after native pending overrides, so only shown rows can be dismissed", () => {
    const second = { ...row, number: 2 };
    const override = pullRequestOverrideAfterAction(row, "close", new Date(), 1)!;
    const displayed = visibility.filter(
      applyPullRequestOverrides(
        [row, second],
        new Map([[pullRequestEntryKey(row), override]]),
        pullRequestEntryKey,
        "open",
      ),
    );
    expect(displayed).toEqual([second]);
    act(() => visibility.select(displayed.map(pullRequestEntryKey), true));
    act(() => visibility.dismiss(displayed));
    expect(visibility.filter([row, second])).toEqual([row]);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("keeps legacy dismissals environment-local and separates providers and hosts", () => {
    window.localStorage.setItem(
      "t3.pullRequests.removed:env-1",
      JSON.stringify([pullRequestEntryKey(row)]),
    );
    act(() => renderer?.unmount());
    mount();
    expect(visibility.filter([row, { ...row, environmentId: other }])).toEqual([
      { ...row, environmentId: other },
    ]);
    act(() => visibility.restore());
    act(() => visibility.select([pullRequestEntryKey(row)], true));
    act(() => visibility.dismiss([row]));
    const gitlab = { ...row, provider: "gitlab" as const };
    const enterprise = { ...row, host: "github.acme.test" };
    expect(visibility.filter([row, gitlab, enterprise])).toEqual([gitlab, enterprise]);
  });
});

describe("project exclusion on the native assignment path", () => {
  it("does not query a hidden owner through another environment, filters late rows, and restores", () => {
    const own = {
      id: row.projectId,
      environmentId: env,
      repositoryIdentity: { canonicalKey: "github.com/acme/repo" },
    };
    const copy = { ...own, environmentId: other };
    const unique = { id: ProjectId.make("other-project"), environmentId: other };
    const projects = [own, copy, unique];
    const assignment = assignProjectsToEnvironments(projects, environments, env);
    const queries = [...assignment].map(([environmentId, projectIds]) => ({
      environmentId,
      projectIds,
    }));
    act(() => visibility.excludeProject(own, true));
    expect(visibility.filterQueries(queries, projects, true)).toEqual([
      { environmentId: other, projectIds: [unique.id] },
    ]);
    expect(visibility.filter([row, { ...row, environmentId: other }])).toEqual([
      { ...row, environmentId: other },
    ]);
    expect(visibility.filterQueries(queries, projects, false)).toEqual(queries);
    expect(enqueue).not.toHaveBeenCalled();
    act(() => renderer?.unmount());
    mount();
    expect(visibility.isProjectExcluded(own)).toBe(true);
    scopedProjectId = own.id;
    act(() => renderer?.update(createElement(Surface)));
    expect(visibility.filterQueries([{ environmentId: env }], projects, true)).toEqual([
      { environmentId: env },
    ]);
    expect(visibility.filter([row])).toEqual([row]);
    scopedProjectId = undefined;
    act(() => renderer?.update(createElement(Surface)));
    act(() => visibility.restoreProjects());
    expect(visibility.filterQueries(queries, projects, true)).toEqual(queries);
    expect(visibility.filter([row])).toEqual([row]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
