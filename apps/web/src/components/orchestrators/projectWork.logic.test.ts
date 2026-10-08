import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TaskStatus } from "./projectRequests.logic";
import { deriveBlocked } from "./projectWork.logic";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function issue(number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    host: "git.example",
    repository: "brad/printcell",
    number,
    title: `Task ${number}`,
    url: `https://git.example/brad/printcell/issues/${number}`,
    status: "in-progress",
    labels: ["ask:task"],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: ago(10),
    updatedAt: ago(0),
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  };
}

function thread(id: string, overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id,
    title: `Worker ${id}`,
    updatedAt: ago(0),
    createdAt: ago(30),
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const active = (...issues: ProjectIssue[]) =>
  new Map<string, TaskStatus>(
    issues.map((item) => [`${item.repository}#${item.number}`, "active"]),
  );

function blocked(
  issues: ProjectIssue[],
  threads: EnvironmentThreadShell[] = [],
  blockedWorkers: Parameters<typeof deriveBlocked>[0]["blockedWorkers"] = [],
) {
  return deriveBlocked({
    blockedWorkers,
    issues,
    statuses: active(...issues),
    threads: [thread("root"), ...threads],
    rootThreadId: "root",
    now: NOW,
  });
}

describe("deriveBlocked", () => {
  it("lists a task whose blocker is still open, named by its title, with an Open blocker button", () => {
    const worker = thread("w1");
    const rows = blocked(
      [
        issue(5, { blockedBy: [9], linkedThreadIds: ["w1" as never] }),
        issue(9, { status: "pending" }),
      ],
      [worker],
    );
    expect(rows).toEqual([
      {
        key: "blocked-by:brad/printcell#5",
        kind: "blocked-by",
        title: "Task 5",
        cause: "Blocked by Task 9",
        owner: { id: "w1", title: "Worker w1" },
        next: null,
        action: { label: "Open blocker", url: "https://git.example/brad/printcell/issues/9" },
      },
    ]);
  });

  it("drops the row once the blocker is closed or no longer listed", () => {
    expect(
      blocked([issue(5, { blockedBy: [9] }), issue(9, { closedAt: ago(1), status: "done" })]),
    ).toEqual([]);
    expect(blocked([issue(5, { blockedBy: [9] })])).toEqual([]);
  });

  it("marks an Active task untouched for 3+ days as stuck, counted in whole days", () => {
    const [row] = blocked([
      issue(5, {
        updatedAt: ago(4.5),
        latestComment: {
          author: "a",
          body: "Progress: waiting on the vendor",
          createdAt: ago(4.5),
        },
      }),
    ]);
    expect(row).toMatchObject({
      kind: "stuck",
      cause: "Stuck 4d",
      next: "waiting on the vendor",
      action: null,
      owner: null,
    });
    expect(blocked([issue(5, { updatedAt: ago(2.9) })])).toEqual([]);
  });

  it("does not call a task stuck while its worker is still active", () => {
    const worker = thread("w1", { latestUserMessageAt: ago(0.1) });
    expect(
      blocked([issue(5, { updatedAt: ago(5), linkedThreadIds: ["w1" as never] })], [worker]),
    ).toEqual([]);
  });

  it("keeps a task stuck when only metadata writes touched its worker", () => {
    const worker = thread("w1", { updatedAt: ago(0.1), latestUserMessageAt: ago(6) });
    const rows = blocked(
      [issue(5, { updatedAt: ago(5), linkedThreadIds: ["w1" as never] })],
      [worker],
    );
    expect(rows.map((row) => row.kind)).toEqual(["stuck"]);
  });

  it("only considers Active tasks and skips parked ones", () => {
    const pending = issue(5, { updatedAt: ago(9) });
    expect(
      deriveBlocked({
        blockedWorkers: [],
        issues: [pending],
        statuses: new Map([["brad/printcell#5", "pending"]]),
        threads: [],
        rootThreadId: "root",
        now: NOW,
      }),
    ).toEqual([]);
    expect(blocked([issue(5, { updatedAt: ago(9), labels: ["parked"] })])).toEqual([]);
  });

  it("lists a blocked worker with its own reason, or that it failed", () => {
    const rows = blocked(
      [],
      [],
      [
        { thread: thread("w1"), latestLine: "Blocked: need the printer password" },
        { thread: thread("w2"), latestLine: "Tests ran" },
        { thread: thread("w3"), latestLine: "Blocked" },
      ],
    );
    expect(rows.map((row) => [row.title, row.cause])).toEqual([
      ["Worker w1", "need the printer password"],
      ["Worker w2", "Failed"],
      ["Worker w3", "Blocked"],
    ]);
    expect(rows[0]?.owner).toEqual({ id: "w1", title: "Worker w1" });
  });

  it("lets a blocked worker explain its own stuck task instead of listing it twice", () => {
    const worker = thread("w1");
    const task = issue(5, { updatedAt: ago(6), linkedThreadIds: ["w1" as never] });
    const rows = blocked([task], [worker], [{ thread: worker, latestLine: "Blocked: no access" }]);
    expect(rows.map((row) => row.kind)).toEqual(["worker"]);
    expect(rows[0]?.title).toBe("Task 5");
  });

  it("orders workers, then blocked tasks, then the longest stuck first", () => {
    const rows = blocked(
      [
        issue(1, { updatedAt: ago(4) }),
        issue(2, { updatedAt: ago(8) }),
        issue(3, { blockedBy: [4] }),
        issue(4, { status: "pending" }),
      ],
      [],
      [{ thread: thread("w1"), latestLine: "Blocked: x" }],
    );
    expect(rows.map((row) => row.key)).toEqual([
      "worker:w1",
      "blocked-by:brad/printcell#3",
      "stuck:brad/printcell#2",
      "stuck:brad/printcell#1",
    ]);
  });
});
