import { describe, expect, it } from "vite-plus/test";
import { DateTime } from "effect";
import { EnvironmentId, ThreadId, RunId, ProviderInstanceId, TurnId } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import type { OrchestratorThreadShell as EnvironmentThreadShell } from "./orchestrators.ts";
import {
  buildOrchestratorSummaries,
  buildStandaloneThreadGroups,
  orchestratorDoneSince,
  projectSidebarBucket,
  isThreadWorking,
  joinOrchestratorMetadata,
  lastActivityAt,
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

type Overrides = Partial<EnvironmentThreadShell> & {
  session?: {
    threadId: string;
    status: string;
    providerName: string;
    runtimeMode: string;
    activeTurnId: string | null;
    updatedAt: string;
    lastError: string | null;
  } | null;
  latestTurn?: {
    turnId: string;
    state: string;
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    assistantMessageId: null;
  } | null;
  agentPanelSummary?: {
    latestOutput: string | null;
    contextTokens: null;
    processedTokens: null;
    toolCalls: number;
    lastActivityAt: string;
  };
};
// Keep the V1 scenarios, expressing their sessions/turns as native V2 shell state.
const thread = (
  id: string,
  parentThreadId: string | null,
  overrides: Overrides = {},
): EnvironmentThreadShell => {
  const { session, latestTurn, agentPanelSummary, ...fields } = overrides;
  const base = presentThreadShell(EnvironmentId.make("env-1"), {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    projectId: "project-a" as EnvironmentThreadShell["projectId"],
    createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    pendingBackgroundTasks: [],
  });
  return {
    ...base,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
    ...fields,
    ...(session
      ? {
          runtime: {
            status: session.status === "error" ? ("failed" as const) : ("running" as const),
            activeRunId: session.activeTurnId === null ? null : RunId.make(session.activeTurnId),
            providerInstanceId: ProviderInstanceId.make(session.providerName),
            providerName: session.providerName,
            updatedAt: session.updatedAt,
            lastError: session.lastError,
          },
        }
      : {}),
    ...(latestTurn
      ? {
          latestRun: {
            runId: RunId.make(latestTurn.turnId),
            status:
              latestTurn.state === "error"
                ? ("failed" as const)
                : latestTurn.state === "interrupted"
                  ? ("interrupted" as const)
                  : ("completed" as const),
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt,
            completedAt: latestTurn.completedAt,
            assistantMessageId: null,
          },
        }
      : {}),
    ...(agentPanelSummary
      ? {
          updatedAt: agentPanelSummary.lastActivityAt,
          latestUserMessageAt: agentPanelSummary.lastActivityAt,
          source: {
            ...base.source,
            workerSummary: {
              output: agentPanelSummary.latestOutput,
              activity: null,
              usedTokens: null,
              toolCount: agentPanelSummary.toolCalls,
              messageCount: 0,
              history: "v2" as const,
            },
          },
        }
      : {}),
  };
};

it("Projects includes only a delegator and explicitly marked subprojects after joining seeded metadata", () => {
  const root = thread("delegator", null, { pinnedAt: "2026-10-01T00:00:00.000Z" });
  const workers = Array.from({ length: 5 }, (_, i) =>
    thread(`delegate-${i}`, null, { pinnedAt: i === 0 ? "2026-10-01T00:00:00.000Z" : null }),
  );
  const rows = workers.map((worker) => ({
    environmentId: root.environmentId,
    threadId: worker.id,
    parentThreadId: root.id,
    subproject: "off" as const,
    settleOnComplete: true,
  }));
  const joined = joinOrchestratorMetadata([root, ...workers], rows);
  expect(
    buildOrchestratorSummaries(joined, [project("project-a")]).map((summary) => summary.root.id),
  ).toEqual([root.id]);
  const withSubproject = joinOrchestratorMetadata(
    [root, ...workers],
    rows.map((row, i) => (i === 1 ? { ...row, subproject: "on" as const } : row)),
  );
  expect(
    buildOrchestratorSummaries(withSubproject, [project("project-a")]).map(
      (summary) => summary.root.id,
    ),
  ).toEqual([root.id, workers[1]!.id]);
});

describe("buildOrchestratorSummaries", () => {
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

  it("orders projects by pin without promoting a pinned thread that has no workers", () => {
    const chief = thread("chief", null, {
      pinnedAt: "2026-10-05T00:00:00.000Z",
      pinOrderKey: "a",
    });
    const chiefWorker = thread("chief-worker", "chief");
    const busy = thread("busy", null, { hasPendingApprovals: true });
    const busyWorker = thread("busy-worker", "busy", { hasPendingApprovals: true });
    const pinnedLoner = thread("pinned-loner", null, {
      pinnedAt: "2026-10-05T00:00:00.000Z",
      pinOrderKey: "b",
    });
    const lone = thread("lone", null);
    const all = [busy, busyWorker, chief, chiefWorker, pinnedLoner, lone];
    const summaries = buildOrchestratorSummaries(all, []);
    // Only the two roots that own workers are projects; the pin alone is not enough.
    expect(summaries.map((item) => item.root.id).toSorted()).toEqual(["busy", "chief"]);
    // A pin still leads the list, ahead of a project that needs you.
    expect(sortOrchestratorSummariesForSidebar(summaries, 0).map((item) => item.root.id)).toEqual([
      "chief",
      "busy",
    ]);
    // Projects own their whole tree in Threads mode, pinned root included.
    expect(threadsVisibleInThreadsMode(all, true).map((item) => item.id)).toEqual([
      "pinned-loner",
      "lone",
    ]);
  });

  it("keeps a marked standing orchestrator in Projects with no workers of its own", () => {
    const standing = thread("standing", null, { subproject: "on" });
    const plain = thread("plain", null);
    const all = [standing, plain];
    expect(buildOrchestratorSummaries(all, []).map((item) => item.root.id)).toEqual(["standing"]);
    // Marked projects own their row in Projects, so they leave the Threads list too.
    expect(threadsVisibleInThreadsMode(all, true).map((item) => item.id)).toEqual(["plain"]);
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

describe("subprojects", () => {
  const running = (id: string): NonNullable<Overrides["session"]> => ({
    threadId: id,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastError: null,
  });

  it("gives a mode-on nested thread its own project and keeps its workers out of the parent's tree", () => {
    const root = thread("root", null);
    const sub = thread("sub", "root", { subproject: "on" });
    const subWorker = thread("sub-worker", "sub", { hasPendingUserInput: true });
    const worker = thread("worker", "root", { session: running("worker") });
    const summaries = buildOrchestratorSummaries(
      [root, sub, subWorker, worker],
      [project("project-a")],
    );
    const byId = new Map(summaries.map((item) => [item.root.id as string, item]));

    expect([...byId.keys()].toSorted()).toEqual(["root", "sub"]);
    const parent = byId.get("root")!;
    expect(parent.parentProjectKey).toBeNull();
    expect(parent.descendants.map((item) => item.id)).toEqual(["worker"]);
    expect(parent.subprojects.map((item) => item.root.id)).toEqual(["sub"]);
    expect(parent.needsYou).toEqual([]);
    // The parent's rollup counts what is waiting on you inside the subproject.
    expect(parent.rollup.needsYou).toBe(1);
    // The worker running under the parent, plus the subproject's worker waiting on an answer.
    expect(parent.rollup.working).toBe(2);
    expect(parent.activeWorkerCount).toBe(1);
    const child = byId.get("sub")!;
    expect(child.parentProjectKey).toBe("env-1:root");
    expect(child.descendants.map((item) => item.id)).toEqual(["sub-worker"]);
    expect(child.needsYou.map((item) => item.thread.id)).toEqual(["sub-worker"]);
    expect(child.rollup.needsYou).toBe(1);
  });

  it("leaves auto and off threads, and a top-level thread marked on, as before", () => {
    const root = thread("root", null);
    const auto = thread("auto", "root", { subproject: "auto" });
    const off = thread("off", "root", { subproject: "off" });
    const autoWorker = thread("auto-worker", "auto");
    const top = thread("top", null, { subproject: "on" });
    const topWorker = thread("top-worker", "top");
    const summaries = buildOrchestratorSummaries(
      [root, auto, off, autoWorker, top, topWorker],
      [project("project-a")],
    );
    expect(summaries.map((item) => item.root.id).toSorted()).toEqual(["root", "top"]);
    const parent = summaries.find((item) => item.root.id === "root")!;
    expect(parent.descendants.map((item) => item.id).toSorted()).toEqual([
      "auto",
      "auto-worker",
      "off",
    ]);
    expect(parent.subprojects).toEqual([]);
    expect(summaries.find((item) => item.root.id === "top")!.parentProjectKey).toBeNull();
  });

  it("nests a subproject under the nearest enclosing project, past plain workers", () => {
    const root = thread("root", null);
    const mid = thread("mid", "root", { subproject: "on" });
    const plain = thread("plain", "mid");
    const deep = thread("deep", "plain", { subproject: "on" });
    const summaries = buildOrchestratorSummaries([root, mid, plain, deep], []);
    const byId = new Map(summaries.map((item) => [item.root.id as string, item]));
    expect(byId.get("deep")!.parentProjectKey).toBe("env-1:mid");
    expect(byId.get("mid")!.subprojects.map((item) => item.root.id)).toEqual(["deep"]);
    expect(byId.get("mid")!.descendants.map((item) => item.id)).toEqual(["plain"]);
    expect(byId.get("root")!.subprojects.map((item) => item.root.id)).toEqual(["mid"]);
  });

  it("drives the parent's sidebar bucket and status from its subprojects", () => {
    const root = thread("root", null);
    const quietSub = thread("quiet-sub", "root", { subproject: "on" });
    const busySub = thread("busy-sub", "root", { subproject: "on", session: running("busy-sub") });
    const parent = buildOrchestratorSummaries([root, quietSub, busySub], []).find(
      (item) => item.root.id === "root",
    );
    expect(parent!.status).toBe("supervising");
    expect(parent!.rollup.working).toBe(1);
    expect(projectSidebarBucket(parent!, 0)).toBe("working");

    const asking = thread("asking-sub", "root", { subproject: "on", hasPendingApprovals: true });
    const attention = buildOrchestratorSummaries([root, asking], []).find(
      (item) => item.root.id === "root",
    );
    expect(attention!.needsYou).toEqual([]);
    expect(projectSidebarBucket(attention!, 0)).toBe("needs-you");
  });

  it("folds a settled project into Quiet, unless it still needs you or is working", () => {
    const settledRoot = thread("settled-root", null, { settledOverride: "settled" });
    const settledWorker = thread("settled-worker", "settled-root");
    const settled = buildOrchestratorSummaries([settledRoot, settledWorker], []).find(
      (item) => item.root.id === "settled-root",
    );
    // Recent enough to be "idle" on activity alone; settling is the stronger statement.
    expect(projectSidebarBucket(settled!, 0)).toBe("quiet");

    const askingWorker = thread("asking-worker", "settled-root", { hasPendingUserInput: true });
    const stillAsking = buildOrchestratorSummaries([settledRoot, askingWorker], []).find(
      (item) => item.root.id === "settled-root",
    );
    expect(projectSidebarBucket(stillAsking!, 0)).toBe("needs-you");

    const busyWorker = thread("busy-worker", "settled-root", { session: running("busy-worker") });
    const stillWorking = buildOrchestratorSummaries([settledRoot, busyWorker], []).find(
      (item) => item.root.id === "settled-root",
    );
    expect(projectSidebarBucket(stillWorking!, 0)).toBe("working");

    const liveRoot = thread("live-root", null);
    const liveWorker = thread("live-worker", "live-root");
    const live = buildOrchestratorSummaries([liveRoot, liveWorker], []).find(
      (item) => item.root.id === "live-root",
    );
    expect(projectSidebarBucket(live!, 0)).toBe("idle");
  });

  it("orders a project's subprojects by what needs you first", () => {
    const root = thread("root", null);
    const calm = thread("calm", "root", { subproject: "on", title: "Calm" });
    const asking = thread("asking", "root", {
      subproject: "on",
      title: "Zed",
      hasPendingUserInput: true,
    });
    const parent = buildOrchestratorSummaries([root, calm, asking], []).find(
      (item) => item.root.id === "root",
    );
    expect(
      sortOrchestratorSummariesForSidebar(parent!.subprojects, 0).map((item) => item.root.id),
    ).toEqual(["asking", "calm"]);
  });

  it("makes a subproject with workers whose parent is archived a top-level project", () => {
    const root = thread("root", null, { archivedAt: "2026-10-01T00:00:00.000Z" });
    const sub = thread("sub", "root", { subproject: "on" });
    const worker = thread("worker", "sub");
    // The sidebar and board pass sidecar metadata; the join drops an archived parent.
    const metadata = [
      { environmentId: "env-1", threadId: ThreadId.make("root"), parentThreadId: null },
      {
        environmentId: "env-1",
        threadId: ThreadId.make("sub"),
        parentThreadId: ThreadId.make("root"),
        subproject: "on" as const,
      },
      {
        environmentId: "env-1",
        threadId: ThreadId.make("worker"),
        parentThreadId: ThreadId.make("sub"),
      },
    ];
    const summaries = buildOrchestratorSummaries([root, sub, worker], [], metadata);
    expect(summaries.map((item) => item.root.id)).toEqual(["sub"]);
    expect(summaries[0]?.parentProjectKey).toBeNull();
  });

  it("reads the mode from the nesting sidecar", () => {
    const root = thread("root", null);
    const sub = thread("sub", "root");
    const summaries = buildOrchestratorSummaries(
      [root, sub],
      [],
      [
        {
          environmentId: "env-1",
          threadId: ThreadId.make("sub"),
          parentThreadId: ThreadId.make("root"),
          subproject: "on",
        },
        { environmentId: "env-1", threadId: ThreadId.make("root"), parentThreadId: null },
      ],
    );
    expect(summaries.map((item) => item.root.id).toSorted()).toEqual(["root", "sub"]);
    expect(summaries.find((item) => item.root.id === "sub")!.root.subproject).toBe("on");
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

  it("surfaces a standalone unseen completion from device-local visit state on a pre-V2 server", () => {
    // A pre-V2 server never projects the field at all.
    const { lastVisitedAt: _omitted, ...completed } = thread("completed", null, {
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

  const completedRun = {
    latestTurn: {
      turnId: "turn-completed" as never,
      state: "completed",
      requestedAt: "2026-10-01T00:00:00.000Z",
      startedAt: null,
      completedAt: "2026-10-01T02:00:00.000Z",
      assistantMessageId: null,
    },
  };

  it("surfaces a Completed standalone row from the server visit watermark on V2", () => {
    // V2 servers project lastVisitedAt on the shell and the browser never writes its local map.
    const seenBefore = thread("seen-before", null, {
      ...completedRun,
      lastVisitedAt: "2026-10-01T01:00:00.000Z",
    });
    const seenAfter = thread("seen-after", null, {
      ...completedRun,
      lastVisitedAt: "2026-10-01T03:00:00.000Z",
    });
    const groups = buildStandaloneThreadGroups([seenBefore, seenAfter], [project("project-a")], {});
    expect(groups[0]?.threads.map(({ thread, status }) => [thread.id, status])).toEqual([
      ["seen-before", "completed"],
    ]);
  });

  it("treats a server null as never visited, not as a cue to read the browser-local watermark", () => {
    const rewound = thread("rewound", null, { ...completedRun, lastVisitedAt: null });
    const groups = buildStandaloneThreadGroups([rewound], [project("project-a")], {
      "env-1:rewound": "2026-10-01T03:00:00.000Z",
    });
    expect(groups).toHaveLength(0);
  });

  it("lets the server watermark win over a stale browser-local one", () => {
    const opened = thread("opened", null, {
      ...completedRun,
      lastVisitedAt: "2026-10-01T03:00:00.000Z",
    });
    const groups = buildStandaloneThreadGroups([opened], [project("project-a")], {
      "env-1:opened": "2026-10-01T01:00:00.000Z",
    });
    expect(groups).toHaveLength(0);
  });

  it("counts a log-tailing monitor or command as working-now, not as idle", () => {
    const tailing = thread("tailing", null, {
      pendingBackgroundTasks: [{ taskId: "t1", kind: "command", description: "tail -f" }] as never,
    });
    const groups = buildStandaloneThreadGroups([tailing], [project("project-a")], {});
    expect(groups[0]?.threads[0]?.status).toBe("working");
  });
});

describe("lastActivityAt", () => {
  it("ignores updatedAt bumps from settling or pinning", () => {
    const quiet = thread("quiet-activity", null, {
      updatedAt: "2026-10-09T00:00:00.000Z",
      latestUserMessageAt: "2026-10-02T00:00:00.000Z",
    });
    expect(lastActivityAt(quiet)).toBe("2026-10-02T00:00:00.000Z");
  });

  it("falls back to creation and prefers the newest run or user signal", () => {
    expect(lastActivityAt(thread("fresh", null))).toBe("2026-10-01T00:00:00.000Z");
    const ran = thread("ran", null, {
      latestUserMessageAt: "2026-10-02T00:00:00.000Z",
      latestTurn: {
        turnId: "turn-ran" as never,
        state: "completed",
        requestedAt: "2026-10-02T00:00:00.000Z",
        startedAt: "2026-10-02T00:01:00.000Z",
        completedAt: "2026-10-03T00:00:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(lastActivityAt(ran)).toBe("2026-10-03T00:00:00.000Z");
  });
});

describe("active Codex goal", () => {
  const goal = { objective: "Ship it", status: "active" as const };
  it("keeps a goal-running worker working between turns, but not over a failed run", () => {
    const between = thread("goal-between", null, { codexNativeGoal: goal });
    expect(isThreadWorking(between)).toBe(true);
    const groups = buildStandaloneThreadGroups([between], [project("project-a")], {});
    expect(groups[0]?.threads[0]?.status).toBe("working");
    const failed = thread("goal-failed", null, {
      codexNativeGoal: goal,
      session: {
        threadId: "goal-failed" as EnvironmentThreadShell["id"],
        status: "error",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        updatedAt: "2026-10-01T03:00:00.000Z",
        lastError: "boom",
      },
    });
    expect(isThreadWorking(failed)).toBe(false);
    expect(buildStandaloneThreadGroups([failed], [project("project-a")], {})).toHaveLength(0);
  });
});

describe("isThreadWorking", () => {
  it("is false for a dev server or monitor and true for an active run or subagent", () => {
    const devServer = thread("dev-server", null, {
      pendingBackgroundTasks: [{ taskId: "t1", kind: "command" }] as never,
    });
    expect(isThreadWorking(devServer)).toBe(false);
    const subagent = thread("subagent", null, {
      pendingBackgroundTasks: [{ taskId: "t2", kind: "subagent" }] as never,
    });
    expect(isThreadWorking(subagent)).toBe(true);
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

it("joins imported scope and remote parents from the sidecar, excluding execution lineage and cycles", () => {
  const root = thread("same", null);
  const child = {
    ...thread("same", null),
    environmentId: EnvironmentId.make("remote"),
    lineage: { ...root.lineage, parentThreadId: root.id },
  };
  expect(buildOrchestratorSummaries([root, child], [], [])).toEqual([]);
  const metadata = [
    {
      environmentId: "remote",
      threadId: child.id,
      parentThreadId: null,
      remoteParent: { environmentId: "env-1", threadId: root.id },
      scope: "Imported scope",
    },
  ];
  const joined = joinOrchestratorMetadata([root, child], metadata);
  const summaries = buildOrchestratorSummaries(joined, []);
  expect(summaries[0]?.descendants[0]?.scope).toBe("Imported scope");
  expect(summaries[0]?.root.environmentId).toBe("env-1");
  expect(
    buildOrchestratorSummaries(
      [root, child],
      [],
      [
        ...metadata,
        {
          environmentId: "env-1",
          threadId: root.id,
          parentThreadId: null,
          remoteParent: { environmentId: "remote", threadId: child.id },
        },
      ],
    ),
  ).toEqual([]);
});
