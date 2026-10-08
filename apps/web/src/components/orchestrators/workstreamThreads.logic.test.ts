import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BlockedRow } from "./projectWork.logic";
import type { TaskStatus } from "./projectRequests.logic";
import { blockedNotes, deriveBands } from "./workstreamBands.logic";
import { deriveThreadView, threadTag } from "./workstreamThreads.logic";

const SINCE = "2026-10-04T00:00:00.000Z";

const issue = (number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue =>
  ({
    host: "git.home",
    repository: "brad/repo",
    number,
    title: `Issue ${number}`,
    url: `https://git.home/brad/repo/issues/${number}`,
    status: "pending",
    labels: [],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  }) as ProjectIssue;

const epic = issue(10, { epic: { done: 0, total: 3, remaining: [11, 12, 13] } });

const thread = (
  id: string,
  overrides: {
    working?: boolean;
    approval?: boolean;
    failed?: boolean;
    completedAt?: string;
    output?: string;
    todo?: { completed: number; total: number };
    settled?: boolean;
  } = {},
) =>
  ({
    id,
    title: `Thread ${id}`,
    archivedAt: null,
    settledOverride: overrides.settled ? "settled" : null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    hasPendingApprovals: overrides.approval === true,
    hasPendingUserInput: false,
    runtime: { status: overrides.failed ? "failed" : overrides.working ? "running" : "idle" },
    pendingBackgroundTasks: [],
    codexNativeGoal: null,
    todoProgress: overrides.todo ?? null,
    latestRun: overrides.completedAt ? { completedAt: overrides.completedAt } : null,
    source: { workerSummary: overrides.output ? { output: overrides.output } : undefined },
  }) as unknown as OrchestratorThreadShell;

function view(
  issues: ProjectIssue[],
  statuses: [number, TaskStatus][],
  threads: OrchestratorThreadShell[],
  blocked: BlockedRow[] = [],
) {
  const notes = blockedNotes(blocked);
  const threadsById = new Map(threads.map((t) => [t.id as string, t]));
  const bands = deriveBands({
    issues,
    statuses: new Map(statuses.map(([number, status]) => [`brad/repo#${number}`, status])),
    threadsById,
    rootThreadId: "root",
    since: SINCE,
    taskNotes: notes.tasks,
  });
  return deriveThreadView({
    bands,
    summary: { root: thread("root"), descendants: threads },
    workerNotes: notes.workers,
    since: SINCE,
  });
}

describe("threadTag", () => {
  const context = { since: SINCE, workerNotes: new Map<string, string>() };

  it("tags a thread by what it asks of Brad first", () => {
    expect(threadTag(thread("a", { approval: true, working: true }), context)).toBe("waiting");
    expect(threadTag(thread("a", { failed: true }), context)).toBe("error");
    expect(threadTag(thread("a", { working: true }), context)).toBe("running");
  });

  it("shows a finished thread as done only if it finished since the last visit", () => {
    expect(threadTag(thread("a", { completedAt: "2026-10-05T00:00:00.000Z" }), context)).toBe(
      "done",
    );
    expect(threadTag(thread("a", { completedAt: "2026-10-03T00:00:00.000Z" }), context)).toBeNull();
    expect(
      threadTag(thread("a", { completedAt: "2026-10-05T00:00:00.000Z" }), {
        ...context,
        since: null,
      }),
    ).toBeNull();
  });

  it("tags a failed thread blocked when it says why, and error when it just failed", () => {
    const failed = thread("a", { failed: true });
    expect(threadTag(failed, { since: SINCE, workerNotes: new Map([["a", "blocked: waits on M4"]]) })).toBe(
      "blocked",
    );
    expect(threadTag(failed, { since: SINCE, workerNotes: new Map([["a", "failed"]]) })).toBe("error");
    expect(threadTag(failed, { since: SINCE, workerNotes: new Map() })).toBe("error");
  });

  it("leaves settled threads out and tags a flagged blocked worker as blocked", () => {
    expect(threadTag(thread("a", { working: true, settled: true }), context)).toBeNull();
    expect(
      threadTag(thread("a"), { ...context, workerNotes: new Map([["a", "blocked: waits on M4"]]) }),
    ).toBe("blocked");
  });
});

describe("deriveThreadView", () => {
  it("lists a workstream's threads sorted waiting, blocked, running, done with their own words", () => {
    const issues = [
      epic,
      issue(11, { partOf: 10, linkedThreadIds: ["run"] as never }),
      issue(12, { partOf: 10, linkedThreadIds: ["wait", "fin"] as never }),
    ];
    const result = view(
      issues,
      [
        [11, "active"],
        [12, "active"],
      ],
      [
        thread("run", {
          working: true,
          output: "Suites running.",
          todo: { completed: 3, total: 5 },
        }),
        thread("wait", { approval: true }),
        thread("fin", { completedAt: "2026-10-05T00:00:00.000Z" }),
      ],
    );
    const rows = result.byBand.get("brad/repo#10")!;
    expect(rows.map((row) => [row.threadId, row.tag])).toEqual([
      ["wait", "waiting"],
      ["run", "running"],
      ["fin", "done"],
    ]);
    expect(rows[1]).toMatchObject({ latest: "Suites running.", steps: "3 of 5 steps" });
    expect(result.other).toEqual([]);
  });

  it("shows a task with no thread only when it waits on Brad or is blocked", () => {
    const issues = [
      epic,
      issue(11, { partOf: 10 }),
      issue(12, { partOf: 10 }),
      issue(13, { partOf: 10, blockedBy: [11] }),
    ];
    const rows = view(
      issues,
      [
        [11, "pending"],
        [12, "for-review"],
        [13, "pending"],
      ],
      [],
    ).byBand.get("brad/repo#10")!;
    expect(rows.map((row) => [row.issue?.number, row.tag, row.note])).toEqual([
      [12, "waiting", null],
      [13, "blocked", "blocked by #11"],
    ]);
  });

  it("carries the stuck rule over as 'blocked, stuck 4d' and names a blocked worker's reason, newest first", () => {
    const stuck: BlockedRow = {
      key: "stuck:brad/repo#11",
      kind: "stuck",
      title: "Issue 11",
      cause: "Stuck 4d",
      owner: null,
      next: null,
      action: null,
    };
    const worker: BlockedRow = {
      key: "worker:w",
      kind: "worker",
      title: "Issue 12",
      cause: "waits on M4",
      owner: { id: "w", title: "Thread w" },
      next: null,
      action: null,
    };
    const rows = view(
      [epic, issue(11, { partOf: 10 }), issue(12, { partOf: 10, linkedThreadIds: ["w"] as never })],
      [
        [11, "active"],
        [12, "active"],
      ],
      [thread("w")],
      [stuck, worker],
    ).byBand.get("brad/repo#10")!;
    expect(rows.map((row) => [row.key, row.tag, row.note])).toEqual([
      ["task:brad/repo#11", "blocked", "blocked, stuck 4d"],
      ["thread:w", "blocked", "blocked: waits on M4"],
    ]);
  });

  it("puts threads outside every workstream under Other threads", () => {
    const result = view(
      [
        epic,
        issue(11, { partOf: 10, linkedThreadIds: ["in"] as never }),
        issue(30, { linkedThreadIds: ["loose"] as never }),
      ],
      [[11, "active"]],
      [thread("in", { working: true }), thread("loose", { working: true }), thread("idle")],
    );
    expect(result.byBand.get("brad/repo#10")!.map((row) => row.threadId)).toEqual(["in"]);
    expect(result.other.map((row) => row.threadId)).toEqual(["loose"]);
  });
  it("keeps a task waiting on Brad as the news and hides its finished thread's done row", () => {
    const rows = view(
      [epic, issue(11, { partOf: 10, linkedThreadIds: ["fin"] as never })],
      [[11, "for-review"]],
      [thread("fin", { completedAt: "2026-10-05T00:00:00.000Z", output: "Ready for review." })],
    ).byBand.get("brad/repo#10")!;
    expect(rows.map((row) => [row.key, row.tag])).toEqual([["task:brad/repo#11", "waiting"]]);
  });

  it("does not add a task row when a thread on it already asks for Brad", () => {
    const rows = view(
      [epic, issue(11, { partOf: 10, linkedThreadIds: ["ask"] as never })],
      [[11, "for-review"]],
      [thread("ask", { approval: true })],
    ).byBand.get("brad/repo#10")!;
    expect(rows.map((row) => [row.key, row.tag])).toEqual([["thread:ask", "waiting"]]);
  });

  it("never lists the orchestrator as a thread on a task", () => {
    const rows = view(
      [epic, issue(11, { partOf: 10, linkedThreadIds: ["root"] as never })],
      [[11, "for-review"]],
      [],
    ).byBand.get("brad/repo#10")!;
    expect(rows.map((row) => row.key)).toEqual(["task:brad/repo#11"]);
  });

  it("lists threads linked to the epic itself and the finished threads of a workstream with no open task", () => {
    const rows = view(
      [
        { ...epic, linkedThreadIds: ["owner"] } as unknown as ProjectIssue,
        issue(11, {
          partOf: 10,
          status: "done",
          closedAt: "2026-10-05T00:00:00.000Z",
          linkedThreadIds: ["fin"] as never,
        }),
      ],
      [[11, "complete"]],
      [thread("owner", { working: true }), thread("fin", { completedAt: "2026-10-05T01:00:00.000Z" })],
    ).byBand.get("brad/repo#10")!;
    expect(rows.map((row) => [row.threadId, row.tag])).toEqual([
      ["owner", "running"],
      ["fin", "done"],
    ]);
  });

  it("keeps the blocked-by note on a thread working a blocked task", () => {
    const rows = view(
      [
        epic,
        issue(11, { partOf: 10 }),
        issue(12, { partOf: 10, blockedBy: [11], linkedThreadIds: ["w"] as never }),
      ],
      [
        [11, "pending"],
        [12, "active"],
      ],
      [thread("w", { working: true })],
    ).byBand.get("brad/repo#10")!;
    expect(rows.find((row) => row.threadId === "w")).toMatchObject({
      tag: "running",
      note: "blocked by #11",
    });
  });

  it("shows blocked and waiting tasks outside every workstream under Other threads", () => {
    const stuck: BlockedRow = {
      key: "stuck:brad/repo#30",
      kind: "stuck",
      title: "Issue 30",
      cause: "Stuck 5d",
      owner: null,
      next: null,
      action: null,
    };
    const result = view(
      [issue(30), issue(31)],
      [
        [30, "active"],
        [31, "for-review"],
      ],
      [],
      [stuck],
    );
    expect(result.other.map((row) => [row.key, row.tag, row.note])).toEqual([
      ["task:brad/repo#31", "waiting", null],
      ["task:brad/repo#30", "blocked", "blocked, stuck 5d"],
    ]);
  });

  it("keeps the task's number and stuck note on its thread under Other threads", () => {
    const stuck: BlockedRow = {
      key: "stuck:brad/repo#30",
      kind: "stuck",
      title: "Issue 30",
      cause: "Stuck 4d",
      owner: null,
      next: null,
      action: null,
    };
    const result = view(
      [issue(30, { linkedThreadIds: ["w"] as never })],
      [[30, "active"]],
      [thread("w", { working: true })],
      [stuck],
    );
    expect(result.other.map((row) => [row.key, row.issue?.number, row.note])).toEqual([
      ["thread:w", 30, "blocked, stuck 4d"],
    ]);
  });
});
