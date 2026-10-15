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
import { buildOrchestratorSummaries, isThreadWorking } from "../state/orchestrators.ts";
import type { OrchestratorThreadShell } from "../state/orchestrators.ts";
import { aggregate, isThreadInFlight } from "./aggregation.ts";
import {
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
