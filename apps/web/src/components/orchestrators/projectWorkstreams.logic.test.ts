import type { ProjectIssue, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TaskStatus } from "./projectRequests.logic";
import type { BlockedRow } from "./projectWork.logic";
import { deriveWorkstreams, milestoneLabel } from "./projectWorkstreams.logic";

function issue(number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    host: "git.example",
    repository: "brad/printcell",
    number,
    title: `Task ${number}`,
    url: `https://git.example/brad/printcell/issues/${number}`,
    status: "pending",
    labels: ["ask:task"],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    linkedThreadIds: threads(),
    ...overrides,
  };
}

const epic = (number: number, done: number, remaining: number[], overrides = {}) =>
  issue(number, {
    labels: ["ask:epic"],
    title: `Epic ${number}`,
    epic: { done, total: done + remaining.length, remaining },
    ...overrides,
  });

const threads = (...ids: string[]) => ids as ThreadId[];
const milestone = (title: string) => ({ id: 1, title });
const statuses = (map: Record<string, TaskStatus>) => new Map(Object.entries(map));

function derive(
  issues: ProjectIssue[],
  options: {
    statuses?: Record<string, TaskStatus>;
    working?: string[];
    blockedRows?: BlockedRow[];
  } = {},
) {
  return deriveWorkstreams({
    issues,
    statuses: statuses(options.statuses ?? {}),
    workingThreadIds: new Set(options.working ?? []),
    blockedRows: options.blockedRows ?? [],
    rootThreadId: "root",
  });
}

describe("deriveWorkstreams", () => {
  it("lists open epics with children left, and nothing when there are none", () => {
    expect(derive([issue(1), issue(2)])).toEqual([]);
    const rows = derive([
      epic(10, 0, [11]),
      issue(11),
      epic(20, 3, []),
      epic(30, 1, [31], { closedAt: "2026-10-02T00:00:00.000Z" }),
      epic(40, 0, [41], { labels: ["ask:epic", "parked"] }),
      issue(41),
    ]);
    expect(rows.map((row) => row.epic.number)).toEqual([10]);
  });

  it("reads N of M and the phase", () => {
    const [row] = derive([epic(10, 1, [11, 12]), issue(11), issue(12)], {
      statuses: { "brad/printcell#11": "active" },
    });
    expect(row!.progress).toBe("1 of 3 · Building");
    expect(row!.phase).toBe("Building");
  });

  it("names the earliest open milestone out of the children's milestones", () => {
    const children = [
      issue(11, { milestone: milestone("M2") }),
      issue(12, { milestone: milestone("M1") }),
      issue(13, { milestone: milestone("M10") }),
      issue(14),
    ];
    expect(milestoneLabel(children)).toBe("M1 of M1-M10");
    expect(milestoneLabel([issue(15, { milestone: milestone("M3") })])).toBe("M3");
    expect(milestoneLabel([issue(16)])).toBeNull();
    const [row] = derive([epic(10, 0, [11, 12]), children[0]!, children[1]!]);
    expect(row!.milestone).toBe("M1 of M1-M2");
  });

  it("counts distinct working workers on the epic and its open children", () => {
    const [row] = derive(
      [
        epic(10, 0, [11, 12], { linkedThreadIds: threads("root", "w1") }),
        issue(11, { linkedThreadIds: threads("w1", "w2", "idle") }),
        issue(12, { linkedThreadIds: threads("w3") }),
        issue(13, { linkedThreadIds: threads("w4") }),
      ],
      { working: ["root", "w1", "w2", "w3", "w4"] },
    );
    expect(row!.agents).toBe(3);
  });

  it("picks the first Active child as the next step, else the first Pending one", () => {
    const issues = [epic(10, 0, [11, 12, 13]), issue(11), issue(12), issue(13)];
    expect(derive(issues, { statuses: { "brad/printcell#13": "active" } })[0]!.next).toEqual({
      title: "Task 13",
      status: "active",
    });
    expect(
      derive(issues, {
        statuses: { "brad/printcell#11": "for-review", "brad/printcell#12": "pending" },
      })[0]!.next,
    ).toEqual({ title: "Task 12", status: "pending" });
    expect(
      derive([epic(10, 0, [11]), issue(11)], {
        statuses: { "brad/printcell#11": "for-review" },
      })[0]!.next,
    ).toBeNull();
  });

  it("marks Blocked when a child waits on an open issue, is flagged blocked or has a blocked worker", () => {
    const base = [epic(10, 0, [11, 12]), issue(11), issue(12)];
    expect(derive(base)[0]!.blocked).toBe(false);
    expect(
      derive([epic(10, 0, [11, 12]), issue(11, { blockedBy: [12] }), issue(12)])[0]!.blocked,
    ).toBe(true);
    expect(derive([epic(10, 0, [11]), issue(11, { blockedBy: [99] })])[0]!.blocked).toBe(false);
    const row = (kind: BlockedRow["kind"], key: string, owner: BlockedRow["owner"] = null) =>
      ({ key, kind, title: "", cause: "", owner, next: null, action: null }) as BlockedRow;
    expect(
      derive(base, { blockedRows: [row("stuck", "stuck:brad/printcell#12")] })[0]!.blocked,
    ).toBe(true);
    expect(
      derive(base, { blockedRows: [row("stuck", "stuck:brad/printcell#99")] })[0]!.blocked,
    ).toBe(false);
    expect(
      derive([epic(10, 0, [11]), issue(11, { linkedThreadIds: threads("w1") })], {
        blockedRows: [row("worker", "worker:w1", { id: "w1", title: "W" })],
      })[0]!.blocked,
    ).toBe(true);
  });
});
