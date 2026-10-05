import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, TurnId } from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import {
  buildOrchestratorSummaries,
  buildStandaloneThreadGroups,
  orchestratorDoneSince,
  sortOrchestratorSummariesForSidebar,
  threadsVisibleInThreadsMode,
} from "./orchestrators.ts";

const project = (id: string): EnvironmentProject => ({
  id: id as EnvironmentProject["id"],
  environmentId: "env-1" as EnvironmentProject["environmentId"],
  title: id,
  workspaceRoot: `/repo/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const thread = (
  id: string,
  parentThreadId: string | null,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell => ({
  id: id as EnvironmentThreadShell["id"],
  environmentId: "env-1" as EnvironmentThreadShell["environmentId"],
  projectId: "project-a" as EnvironmentThreadShell["projectId"],
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  parentThreadId: parentThreadId as EnvironmentThreadShell["parentThreadId"],
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  ...overrides,
});

describe("buildOrchestratorSummaries", () => {
  it("includes remote children in project sections, activity counts, and attention", () => {
    const root = thread("root", null);
    const laptop = "laptop" as EnvironmentThreadShell["environmentId"];
    const child = thread("child", null, {
      environmentId: laptop,
      remoteParent: { environmentId: root.environmentId, threadId: root.id },
      hasPendingUserInput: true,
      session: { status: "running" } as EnvironmentThreadShell["session"],
    });
    const laptopProject = { ...project("project-a"), environmentId: laptop };
    const [summary] = buildOrchestratorSummaries(
      [root, child],
      [project("project-a"), laptopProject],
    );
    expect(summary?.descendants).toEqual([child]);
    expect(summary?.projects).toEqual([project("project-a"), laptopProject]);
    expect(summary?.needsYou).toEqual([{ kind: "input", thread: child }]);
    expect(summary?.activeWorkerCount).toBe(1);
    expect(
      buildStandaloneThreadGroups([root, child], [project("project-a"), laptopProject], {}),
    ).toEqual([]);
    expect(buildStandaloneThreadGroups([child], [laptopProject], {})[0]?.threads[0]?.thread).toBe(
      child,
    );
  });
  it("finds top-level orchestrators and rolls nested activity, attention, projects, and links up", () => {
    const root = thread("root", null, {
      issues: [
        {
          host: "gitea.test",
          repository: "owner/repo",
          number: 7,
          url: "https://gitea.test/owner/repo/issues/7",
          linkedAt: "2026-10-01T00:00:00.000Z",
          snapshot: { title: "Issue", state: "open", syncedAt: "2026-10-01T00:00:00.000Z" },
        },
      ],
    });
    const child = thread("child", "root", {
      projectId: "project-b" as EnvironmentThreadShell["projectId"],
    });
    const grandchild = thread("grandchild", "child", {
      hasPendingUserInput: true,
      agentPanelSummary: {
        latestOutput: "Waiting on the API choice",
        contextTokens: null,
        processedTokens: null,
        toolCalls: 2,
        lastActivityAt: "2026-10-01T02:00:00.000Z",
      },
    });
    const [summary] = buildOrchestratorSummaries(
      [root, child, grandchild],
      [project("project-a"), project("project-b")],
    );

    expect(summary?.root.id).toBe("root");
    expect(summary?.status).toBe("supervising");
    expect(summary?.activeWorkerCount).toBe(1);
    expect(summary?.needsYou.map((item) => [item.kind, item.thread.id])).toEqual([
      ["input", "grandchild"],
    ]);
    expect(summary?.projects.map((item) => item.id)).toEqual(["project-a", "project-b"]);
    expect(summary?.issues.map((issue) => issue.number)).toEqual([7]);
  });

  it("includes plan-ready attention and idle blocked work without counting it as active", () => {
    const root = thread("root", null);
    const plan = thread("plan", "root", {
      interactionMode: "plan",
      hasActionableProposedPlan: true,
    });
    const blocked = thread("blocked", "root", {
      agentPanelSummary: {
        latestOutput: "Blocked: waiting for credentials",
        contextTokens: null,
        processedTokens: null,
        toolCalls: 1,
        lastActivityAt: "2026-10-01T04:00:00.000Z",
      },
    });
    const [summary] = buildOrchestratorSummaries([root, plan, blocked], [project("project-a")]);
    expect(summary?.needsYou.map((item) => [item.kind, item.thread.id])).toEqual([
      ["plan", "plan"],
    ]);
    expect(summary?.blocked.map((item) => item.thread.id)).toEqual(["blocked"]);
    expect(summary?.activeWorkerCount).toBe(0);
    expect(summary?.latestActivityAt).toBe("2026-10-01T04:00:00.000Z");
  });

  it("does not classify interrupted turns as blocked", () => {
    const root = thread("root", null);
    const interrupted = thread("interrupted", "root", {
      latestTurn: {
        turnId: TurnId.make("turn-interrupted"),
        state: "interrupted",
        requestedAt: "2026-10-01T02:59:00.000Z",
        startedAt: "2026-10-01T03:00:00.000Z",
        completedAt: "2026-10-01T03:01:00.000Z",
        assistantMessageId: null,
      },
    });
    const failed = thread("failed", "root", {
      latestTurn: {
        turnId: TurnId.make("turn-failed"),
        state: "error",
        requestedAt: "2026-10-01T02:59:00.000Z",
        startedAt: "2026-10-01T03:00:00.000Z",
        completedAt: "2026-10-01T03:01:00.000Z",
        assistantMessageId: null,
      },
    });
    const sessionFailed = thread("session-failed", "root", {
      session: {
        threadId: "session-failed" as EnvironmentThreadShell["id"],
        status: "error",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        updatedAt: "2026-10-01T03:01:00.000Z",
        lastError: "provider exited",
      },
    });

    const [summary] = buildOrchestratorSummaries(
      [root, interrupted, failed, sessionFailed],
      [project("project-a")],
    );

    expect(summary?.blocked.map((item) => item.thread.id)).toEqual(["failed", "session-failed"]);
  });

  it("excludes archived roots, tolerates cycles, and keeps settled roots from supervising", () => {
    const root = thread("root", null, { settledOverride: "settled" });
    const child = thread("child", "root", {
      session: {
        threadId: "child" as EnvironmentThreadShell["id"],
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
        lastError: null,
      },
    });
    const cycle = thread("cycle", "cycle");
    const [summary] = buildOrchestratorSummaries([root, child, cycle], [project("project-a")]);
    expect(summary?.status).toBe("ready");
  });

  it("keeps project rows stable when activity timestamps change inside one bucket", () => {
    const zebra = thread("zebra", null, { title: "Zebra" });
    const alpha = thread("alpha", null, { title: "Alpha" });
    const zebraChild = thread("zebra-child", "zebra", {
      updatedAt: "2026-10-04T05:00:00.000Z",
    });
    const alphaChild = thread("alpha-child", "alpha", {
      updatedAt: "2026-10-04T04:00:00.000Z",
    });
    const before = buildOrchestratorSummaries(
      [zebra, zebraChild, alpha, alphaChild],
      [project("project-a")],
    );
    const after = buildOrchestratorSummaries(
      [zebra, { ...zebraChild, updatedAt: "2026-10-04T06:00:00.000Z" }, alpha, alphaChild],
      [project("project-a")],
    );
    const cutoff = Date.parse("2026-10-01T00:00:00.000Z");
    expect(sortOrchestratorSummariesForSidebar(before, cutoff).map((item) => item.root.id)).toEqual(
      ["alpha", "zebra"],
    );
    expect(sortOrchestratorSummariesForSidebar(after, cutoff).map((item) => item.root.id)).toEqual([
      "alpha",
      "zebra",
    ]);
  });

  it("keeps project trees in Threads only when Projects is disabled", () => {
    const root = thread("root", null, { pinnedAt: "2026-10-01T00:00:00.000Z" });
    const child = thread("child", "root", { pinnedAt: "2026-10-01T00:00:00.000Z" });
    const standalone = thread("standalone", null);
    const archivedParent = thread("archived-parent", null, {
      archivedAt: "2026-10-01T00:00:00.000Z",
    });
    const orphan = thread("orphan", "archived-parent");
    const finishedOnlyRoot = thread("finished-only-root", null);
    const archivedChild = thread("archived-child", "finished-only-root", {
      archivedAt: "2026-10-01T00:00:00.000Z",
    });
    const all = [root, child, standalone, archivedParent, orphan, finishedOnlyRoot, archivedChild];
    expect(threadsVisibleInThreadsMode(all, true).map((item) => item.id)).toEqual([
      "standalone",
      "archived-parent",
      "orphan",
      "finished-only-root",
      "archived-child",
    ]);
    expect(threadsVisibleInThreadsMode(all, false)).toEqual(all);
  });
});

describe("buildStandaloneThreadGroups", () => {
  it("keeps only actionable roots without descendants and sorts needs-you first", () => {
    const approval = thread("approval", null, { hasPendingApprovals: true });
    const working = thread("working", null, {
      updatedAt: "2026-10-01T03:00:00.000Z",
      session: {
        threadId: "working" as EnvironmentThreadShell["id"],
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        updatedAt: "2026-10-01T03:00:00.000Z",
        lastError: null,
      },
    });
    const parent = thread("parent", null, { hasPendingUserInput: true });
    const child = thread("child", "parent");
    const quiet = thread("quiet", null);
    const groups = buildStandaloneThreadGroups(
      [working, parent, child, quiet, approval],
      [project("project-a")],
      {},
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map(({ thread, status }) => [thread.id, status])).toEqual([
      ["approval", "approval"],
      ["working", "working"],
    ]);
  });

  it("surfaces a standalone unseen completion from device-local visit state", () => {
    const completed = thread("completed", null, {
      latestTurn: {
        turnId: "turn-completed" as never,
        state: "completed",
        requestedAt: "2026-10-01T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-10-01T02:00:00.000Z",
        assistantMessageId: null,
      },
    });
    const groups = buildStandaloneThreadGroups([completed], [project("project-a")], {
      "env-1:completed": "2026-10-01T01:00:00.000Z",
    });
    expect(groups[0]?.threads[0]?.status).toBe("completed");
  });
});

describe("orchestratorDoneSince", () => {
  it("returns newly completed and settled descendants only", () => {
    const root = thread("root", null);
    const old = thread("old", "root", {
      latestTurn: {
        turnId: "turn-old" as never,
        state: "completed",
        requestedAt: "2026-10-01T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-10-01T01:00:00.000Z",
        assistantMessageId: null,
      },
    });
    const recent = thread("recent", "root", {
      settledOverride: "settled",
      settledAt: "2026-10-01T03:00:00.000Z",
    });
    const [summary] = buildOrchestratorSummaries([root, old, recent], [project("project-a")]);
    expect(
      orchestratorDoneSince(summary!, "2026-10-01T02:00:00.000Z").map((item) => item.thread.id),
    ).toEqual(["recent"]);
  });
});
