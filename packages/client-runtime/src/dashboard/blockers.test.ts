import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type DashboardAttention,
  type DashboardProject,
  type ProjectIssue,
} from "@t3tools/contracts";
import { presentThreadShell } from "../state/models.ts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import {
  buildOrchestratorSummaries,
  isThreadWorking,
  resolveThreadDisplayStatus,
} from "../state/orchestrators.ts";
import type { OrchestratorThreadShell } from "../state/orchestrators.ts";
import { liveRuntimeRequests } from "./liveAttention.ts";
import { aggregate, isThreadInFlight } from "./aggregation.ts";
import {
  blockerSet,
  projectBlockerSet,
  taskBlockers,
  attentionBlockers,
  blockerHeadline,
  threadBlockers,
  workerCause,
  issueBlockers,
} from "./blockers.ts";

const now = "2026-10-15T10:00:00.000Z";
const id = ThreadId.make;
const shell = (
  name: string,
  source: Partial<typeof v2ThreadShell> = {},
  parent: string | null = null,
): OrchestratorThreadShell => ({
  ...presentThreadShell(EnvironmentId.make("env"), {
    ...v2ThreadShell,
    id: id(name),
    title: name,
    ...source,
  }),
  parentThreadId: parent ? id(parent) : null,
});
const options = { now };
const stopped = {
  latestRunStatus: "interrupted" as const,
  hasLiveTurn: false,
  hasLiveSession: false,
  failedSession: false,
};
const todoProgress = {
  completed: 1,
  total: 2,
  currentStep: { id: "step", text: "Verify the fix", status: "pending" as const },
};
const attention = (
  number: number,
  kind: DashboardAttention["kind"],
  priority = 3,
): DashboardAttention => ({
  id: `issue:host/brad/fork#${number}:attention`,
  taskId: `issue:host/brad/fork#${number}`,
  blockingTaskIds: [],
  requestId: null,
  title: `Item #${number}`,
  kind,
  canRespond: true,
  options: [],
  priority,
  url: `https://host/brad/fork/issues/${number}`,
  threadId: null,
  updatedAt: now,
  deadline: null,
  question: `Please ${kind} this`,
  sourceId: "tracker",
});
const project = (
  name: string,
  parent: string | null,
  items: DashboardAttention[],
): DashboardProject => ({
  id: name,
  rootThreadId: id(name),
  parentId: parent,
  title: name,
  utility: false,
  omittedTaskCount: 0,
  workstreams: [],
  tasks: [],
  attention: items,
  sourceIds: [],
});

describe("threadBlockers", () => {
  it("names synthetic failed retries and retains parent attribution and reversible settle ids", () => {
    const shells = [
      shell("Product"),
      { ...shell("Dashboard", {}, "Product"), subproject: "on" as const },
      ...[1, 2, 3].map((n) =>
        shell(`retry-r${n}`, { status: "failed", lastError: "Model at capacity" }, "Dashboard"),
      ),
    ];
    const blockers = threadBlockers(shells, id("Product"), options);
    expect(blockers.map((b) => b.name)).toEqual(["retry-r1", "retry-r2", "retry-r3"]);
    expect(
      blockers.every((b) => b.reason === "Model at capacity" && b.owner?.name === "Dashboard"),
    ).toBe(true);
    expect(
      blockers.flatMap((b) => (b.action?.type === "settle" ? b.action.threadIds : [])),
    ).toEqual([id("retry-r1"), id("retry-r2"), id("retry-r3")]);
    expect(threadBlockers(shells, id("Dashboard"), options)).toHaveLength(3);
  });
  it("resumes stopped plans and held queues, with no working count for held work", () => {
    const held = shell("held", { status: "queued", queueHeld: true });
    expect(threadBlockers([held], id("held"), options)[0]?.action).toEqual({
      type: "resume-queue",
      threadId: id("held"),
    });
    expect(isThreadInFlight(held.source)).toBe(false);
    expect(isThreadWorking(held)).toBe(false);
    expect(isThreadInFlight({ ...held.source, queueHeld: false })).toBe(true);
    const root = shell("root");
    const child = { ...held, parentThreadId: root.id };
    const summaries = buildOrchestratorSummaries([root, child], []);
    expect(summaries[0]?.rollup.blocked).toBe(1);
    expect(summaries[0]?.rollup.working).toBe(0);
    const plan = shell("plan", { status: "interrupted", planResumeState: stopped, todoProgress });
    expect(threadBlockers([plan], plan.id, options)[0]).toMatchObject({
      kind: "stopped",
      reason: "Verify the fix",
      action: { type: "resume-plan" },
    });
  });
  it("explains BLOCKED lines without offering settle for a live worker", () => {
    const blocked = shell("worker", {
      workerSummary: {
        output: "BLOCKED: Needs a signing key",
        messageCount: 1,
        toolCount: 0,
        usedTokens: null,
        activity: null,
        history: "v2",
      },
    });
    expect(threadBlockers([blocked], blocked.id, options)[0]).toMatchObject({
      kind: "blocked-line",
      reason: "Needs a signing key",
      action: null,
    });
    expect(workerCause({ latestLine: "BLOCKED: Needs a signing key" })).toBe("Needs a signing key");
    expect(
      threadBlockers(
        [shell("running", { status: "running", workerSummary: blocked.source.workerSummary })],
        null,
        options,
      ),
    ).toEqual([]);
  });
  it("excludes settled and archived failures and does not expose actions without permission/capability", () => {
    expect(
      threadBlockers(
        [
          shell("settled", { status: "failed", settledOverride: "settled" }),
          shell("archived", { status: "failed", archivedAt: v2ThreadShell.createdAt }),
        ],
        null,
        options,
      ),
    ).toEqual([]);
    const held = shell("held", { queueHeld: true });
    expect(threadBlockers([held], null, { now, canOperate: false })[0]).toMatchObject({
      action: null,
      actionReason: expect.stringContaining("permission"),
    });
    expect(threadBlockers([held], null, { now, canResumeQueue: false })[0]).toMatchObject({
      action: null,
      actionReason: expect.stringContaining("support"),
    });
  });
  it("waits for usage reset, then offers the resumable plan", () => {
    const limited = shell("limited", {
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: "2026-10-15T11:00:00.000Z",
      planResumeState: { ...stopped, latestRunStatus: "failed" },
      todoProgress,
    });
    expect(threadBlockers([limited], null, options)[0]).toMatchObject({
      kind: "usage-limit",
      action: null,
      reason: "Usage limit, resets 2026-10-15T11:00:00.000Z",
    });
    expect(
      threadBlockers([limited], null, { now: "2026-10-15T11:00:00.000Z" })[0]?.action?.type,
    ).toBe("resume-plan");
    expect(
      threadBlockers(
        [shell("unknown", { status: "failed", lastErrorClass: "usage_limit" })],
        null,
        options,
      )[0]?.action,
    ).toBeNull();
  });
});

describe("attentionBlockers", () => {
  const productItems = [352, 350, 339, 340, 342, 343, 345, 348, 256, 125].map((n) =>
    attention(n, "test", n === 352 ? 0 : 3),
  );
  productItems.push(attention(346, "review"), attention(338, "decision"));
  const dashboardItems = [attention(304, "review", 1), attention(305, "review")];
  it("counts all twelve Product items, keeps their kinds and passes through #355 answer data", () => {
    const snapshot = {
      asOf: now,
      projects: [project("Product", null, productItems.toReversed())],
    };
    const result = attentionBlockers(snapshot, id("Product"), { stored: true });
    expect(result.blockers).toHaveLength(12);
    expect(blockerHeadline(result.blockers)).toBe("Waiting on Brad: test #352 and 11 more");
    expect(result).toMatchObject({ asOf: now, stored: true });
    expect(result.blockers[0]?.attention).toBe(productItems[0]);
    expect(result.blockers.at(-2)?.attention?.kind).toBe("test");
    expect(result.blockers.find((b) => b.attention?.kind === "decision")?.action?.type).toBe(
      "answer",
    );
  });
  it("scopes Dashboard items and rolls them into Product once, including runtime questions", () => {
    const runtime = {
      ...attention(999, "question"),
      id: "runtime:thread:request",
      taskId: "thread:request",
    };
    const snapshot = {
      asOf: now,
      projects: [
        project("Product", null, productItems),
        project("Dashboard", "Product", dashboardItems),
        project("Other", null, [runtime]),
      ],
    };
    expect(blockerHeadline(attentionBlockers(snapshot, id("Dashboard")).blockers)).toBe(
      "Waiting on Brad: review #304 and 1 more",
    );
    expect(attentionBlockers(snapshot, id("Product")).blockers).toHaveLength(14);
    expect(
      attentionBlockers(snapshot, id("Other"), { canOperate: false }).blockers[0]?.action,
    ).toBeNull();
    expect(attentionBlockers(snapshot, id("missing")).blockers).toEqual([]);
    expect(
      attentionBlockers(snapshot, id("Dashboard"), { taskId: dashboardItems[0]!.taskId }).blockers,
    ).toHaveLength(1);
  });
});

it("keeps held plan rows visible as blocked through dashboard aggregation", () => {
  const root = shell("root");
  const held = shell("held", { status: "queued", queueHeld: true, todoProgress }, "root");
  const result = aggregate({
    shells: [root.source, held.source],
    metadata: [
      { threadId: root.id, parentThreadId: null, subproject: "on" },
      { threadId: held.id, parentThreadId: root.id },
    ],
    issues: new Map(),
    sources: [],
    plans: [],
    samples: [],
    now,
  });
  expect(result.projects.flatMap((p) => p.tasks)).toContainEqual(
    expect.objectContaining({ threadId: held.id, status: "blocked" }),
  );
});

it("names issue dependencies, matches their repository, and drops closed dependencies", () => {
  const issue: ProjectIssue = {
    host: "host",
    repository: "brad/fork",
    number: 1,
    title: "Task",
    url: "https://host/brad/fork/issues/1",
    status: "pending",
    labels: [],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    linkedThreadIds: [],
    blockedBy: [2, 3, 4],
  };
  const dependency = {
    ...issue,
    number: 2,
    title: "Signing key",
    blockedBy: [],
    url: "https://host/brad/fork/issues/2",
  };
  const result = issueBlockers(issue, [
    dependency,
    { ...dependency, number: 3, status: "done" },
    { ...dependency, number: 4, repository: "other/repo" },
  ]);
  expect(result.map((b) => b.name)).toEqual(["#2: Signing key", "#4"]);
  expect(result[0]).toMatchObject({
    action: null,
    target: { issueUrl: dependency.url },
    actionReason: "This clears when the blocking issue closes.",
  });
});

it("bounds cyclic trees, deduplicates attention and preserves runtime approval semantics", () => {
  const one = {
    ...attention(1, "approval"),
    requestId: "request",
    answer: "thread-approval" as const,
    canRespond: false,
  };
  const snapshot = {
    asOf: now,
    projects: [project("Product", "Child", [one]), project("Child", "Product", [one])],
  };
  const result = attentionBlockers(snapshot, id("Product"));
  expect(result.blockers).toHaveLength(1);
  expect(result.blockers[0]).toMatchObject({
    action: null,
    attention: { kind: "approval", requestId: "request", answer: "thread-approval" },
  });
  const a = shell("a", { status: "failed" }, "b");
  const b = shell("b", { status: "failed" }, "a");
  expect(threadBlockers([a, b], a.id, options)).toHaveLength(2);
  expect(threadBlockers([a], a.id, { now, canSettle: false })[0]?.action).toBeNull();
  const plan = shell(
    "stopped",
    { status: "interrupted", planResumeState: stopped, todoProgress },
    "root",
  );
  const summaries = buildOrchestratorSummaries([shell("root"), plan], []);
  expect(summaries[0]?.rollup.blocked).toBe(1);
  expect(threadBlockers([plan], plan.id, { now, canResumePlan: false })[0]?.action).toBeNull();
});

it("never settles a failed shell that still has a live provider turn", () => {
  const live = shell("live", {
    status: "failed",
    planResumeState: { ...stopped, latestRunStatus: "failed", hasLiveTurn: true },
    todoProgress,
  });
  expect(threadBlockers([live], live.id, options)[0]).toMatchObject({
    action: null,
    actionReason: expect.stringContaining("running turn"),
  });
});

const issueFixture = (number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue => ({
  host: "host",
  repository: "brad/fork",
  number,
  title: `Task ${number}`,
  url: `https://host/brad/fork/issues/${number}`,
  status: "in-progress",
  labels: [],
  isRequest: false,
  requestSource: null,
  assignees: [],
  comments: 0,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
  linkedThreadIds: [],
  ...overrides,
});

it.each(["settled", "archived"])("keeps failed children reachable through a %s worker", (state) => {
  const root = shell("root");
  const parent = shell(
    "parent",
    state === "settled" ? { settledOverride: "settled" } : { archivedAt: v2ThreadShell.createdAt },
    "root",
  );
  const child = shell("child", { status: "failed" }, "parent");
  const shells = [root, parent, child];
  const row = buildOrchestratorSummaries(shells, []).find((row) => row.root.id === root.id)!;
  expect(blockerSet(row, options).map((b) => b.name)).toEqual(["child"]);
  expect(row.rollup.blocked).toBe(blockerSet(row, options).length);
  expect(threadBlockers(shells, root.id, options)).toEqual(blockerSet(row, options));
});

it("uses organize nesting for both the red count and the named set", () => {
  const root = shell("Product");
  const nested = {
    ...shell("Dashboard", { status: "failed" }),
    subproject: "on" as const,
    supervisionParentKey: `env:${root.id}`,
  };
  const row = buildOrchestratorSummaries([root, nested], [])[0]!;
  expect(row.rollup.blocked).toBe(1);
  expect(blockerSet(row, options)).toMatchObject([
    { name: "Dashboard", action: null, actionReason: expect.stringContaining("heads") },
  ]);
  expect(row.rollup.blocked).toBe(blockerSet(row, options).length);
});

it("keeps remote worker identities distinct and counts their named set", () => {
  const root = shell("Product");
  const local = shell("worker", { status: "failed" }, "Product");
  const remote = {
    ...shell("worker", { status: "failed" }),
    environmentId: EnvironmentId.make("remote"),
    remoteParent: { environmentId: root.environmentId, threadId: root.id },
  };
  const row = buildOrchestratorSummaries([root, local, remote], [])[0]!;
  const blockers = blockerSet(row, options);
  expect(row.rollup.blocked).toBe(2);
  expect(blockers).toHaveLength(row.rollup.blocked);
  expect(new Set(blockers.map((b) => b.key)).size).toBe(2);
  expect(blockers[1]?.target.environmentId).toBe("remote");
});

it("names issue-blocked and stale tasks in the same project blocked set", () => {
  const row = buildOrchestratorSummaries([{ ...shell("root"), subproject: "on" }], [])[0]!;
  const issues = [
    issueFixture(1, { blockedBy: [2] }),
    issueFixture(2, { status: "pending", title: "Signing key" }),
    issueFixture(3, { updatedAt: "2026-10-11T10:00:00.000Z" }),
  ];
  expect(projectBlockerSet(row, issues, options)).toMatchObject([
    { name: "Task 1", kind: "blocked-by", reason: "Blocked by #2: Signing key." },
    { name: "Task 3", kind: "stuck", reason: expect.stringContaining("Stuck 4d") },
  ]);
});

it("gives held queues and missing stored asks their own task causes", () => {
  const held = shell("held", { status: "queued", queueHeld: true, todoProgress });
  const result = aggregate({
    shells: [held.source],
    metadata: [{ threadId: held.id, parentThreadId: null, subproject: "on" }],
    issues: new Map(),
    sources: [],
    plans: [],
    samples: [],
    now,
  });
  const task = result.projects[0]!.tasks[0]!;
  expect(taskBlockers(task, [held], [], options)).toMatchObject([
    { kind: "held-queue", reason: "Queue held on held.", action: { type: "resume-queue" } },
  ]);
  const idle = shell("held");
  expect(
    taskBlockers({ ...task, attentionIds: ["runtime:held:missing"] }, [idle], [], options),
  ).toMatchObject([
    {
      kind: "waiting-question",
      reason: "Waiting on a question in held (open the thread).",
      action: null,
    },
  ]);
});

it("never settles project roots or subproject heads while failed workers remain eligible", () => {
  const shells = [
    shell("root", { status: "failed" }),
    { ...shell("head", { status: "failed" }, "root"), subproject: "on" as const },
    shell("worker", { status: "failed" }, "head"),
  ];
  const blockers = blockerSet(buildOrchestratorSummaries(shells, [])[0]!, options);
  expect(blockers.map((b) => b.action?.type ?? null)).toEqual([null, null, "settle"]);
  expect(blockers.slice(0, 2).every((b) => b.actionReason?.includes("heads"))).toBe(true);
});

it("a running turn wins over its held follow-up queue", () => {
  const running = shell("worker", { status: "running", queueHeld: true, todoProgress }, "root");
  expect(isThreadWorking(running)).toBe(true);
  expect(resolveThreadDisplayStatus(running)).toBe("working");
  expect(isThreadInFlight(running.source)).toBe(true);
  const dashboard = aggregate({
    shells: [shell("root").source, running.source],
    metadata: [
      { threadId: id("root"), parentThreadId: null, subproject: "on" },
      { threadId: running.id, parentThreadId: id("root") },
    ],
    issues: new Map(),
    sources: [],
    plans: [],
    samples: [],
    now,
  });
  expect(dashboard.projects.flatMap((project) => project.tasks)).toContainEqual(
    expect.objectContaining({ threadId: running.id, status: "working" }),
  );
  const row = buildOrchestratorSummaries([shell("root"), running], [])[0]!;
  expect(row.rollup).toMatchObject({ working: 1, blocked: 0 });
  expect(blockerSet(row, options)).toEqual([]);
});

it("ignores failures with live background work, retired trees and stale error text", () => {
  const root = shell("root");
  const working = {
    ...shell("active", { status: "failed" }, "root"),
    pendingBackgroundTasks: [
      { kind: "subagent" as const, taskId: "task", childThreadId: id("child") },
    ],
  };
  const retired = shell("Old (retired)", {}, "root");
  const child = shell("old-worker", { status: "failed" }, retired.id);
  const blocked = shell(
    "blocked",
    {
      lastError: "Old failure",
      workerSummary: {
        output: "BLOCKED: Need credentials\nT3_NOTIFY: attention",
        messageCount: 1,
        toolCount: 0,
        usedTokens: null,
        activity: null,
        history: "v2",
      },
    },
    "root",
  );
  expect(threadBlockers([child, retired], null, options)).toEqual([]);
  const row = buildOrchestratorSummaries([root, working, retired, child, blocked], [])[0]!;
  expect(row.rollup.blocked).toBe(1);
  expect(blockerSet(row, options)).toMatchObject([{ name: "blocked", reason: "Need credentials" }]);
});

it("unions stored tracker items with live asks even when stored attention is nonempty", () => {
  const root = shell("Product");
  const child = shell(
    "worker",
    {
      pendingRuntimeRequest: {
        id: "request" as never,
        kind: "user_input",
        createdAt: v2ThreadShell.createdAt as never,
      },
    },
    "Product",
  );
  const live = liveRuntimeRequests([
    { environmentId: "env", threads: [root.source, child.source] },
  ]);
  const snapshot = { asOf: now, projects: [project("Product", null, [attention(1, "test")])] };
  const result = attentionBlockers(snapshot, root.id, {
    stored: true,
    live,
    shells: [root, child],
    environmentId: root.environmentId,
  });
  expect(result.blockers.map((b) => b.key)).toEqual([
    "runtime:worker:request",
    attention(1, "test").id,
  ]);
  expect(result.blockers[0]).toMatchObject({ action: null, owner: { name: "Product" } });
  expect(blockerHeadline([result.blockers[0]!])).toBe("Waiting on Brad: “worker”");
});
