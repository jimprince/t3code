import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatIssueAge, groupProjectIssues } from "./projectIssuesBoard.logic";

function issue(number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    host: "git.example",
    repository: "brad/printcell",
    number,
    title: `Issue ${number}`,
    url: `https://git.example/brad/printcell/issues/${number}`,
    status: "pending",
    labels: [],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  };
}

describe("groupProjectIssues", () => {
  it("sorts tasks into the four status lanes from the shared statuses, and folds backlog", () => {
    const { lanes, backlog } = groupProjectIssues(
      [
        issue(1, { status: "needs-review" }),
        issue(2, { status: "in-progress" }),
        issue(3),
        issue(4, { status: "backlog" }),
        issue(5, { status: "done", closedAt: "2026-10-02T00:00:00.000Z" }),
        issue(6, { status: "archived" }),
        issue(8),
      ],
      new Map([
        ["brad/printcell#1", "for-review"],
        ["brad/printcell#2", "active"],
        ["brad/printcell#3", "pending"],
        ["brad/printcell#4", "pending"],
        ["brad/printcell#5", "complete"],
        // A request whose thread answered: pending on the tracker, but for Brad's review.
        ["brad/printcell#8", "for-review"],
      ]),
    );
    expect(lanes["for-review"].map((item) => item.number)).toEqual([1, 8]);
    expect(lanes.active.map((item) => item.number)).toEqual([2]);
    expect(lanes.pending.map((item) => item.number)).toEqual([3]);
    expect(backlog.map((item) => item.number)).toEqual([4]);
    expect(lanes.complete.map((item) => item.number)).toEqual([5]);
  });

  it("puts the longest-waiting open issue first and the latest closed first", () => {
    const { lanes } = groupProjectIssues([
      issue(1, { updatedAt: "2026-10-03T00:00:00.000Z" }),
      issue(2, { updatedAt: "2026-09-30T00:00:00.000Z" }),
      issue(3, { status: "done", closedAt: "2026-10-01T00:00:00.000Z" }),
      issue(4, { status: "done", closedAt: "2026-10-03T00:00:00.000Z" }),
    ]);
    expect(lanes.pending.map((item) => item.number)).toEqual([2, 1]);
    expect(lanes.complete.map((item) => item.number)).toEqual([4, 3]);
  });
});

describe("formatIssueAge", () => {
  it("formats minutes, hours and days", () => {
    const now = Date.parse("2026-10-04T12:00:00.000Z");
    expect(formatIssueAge("2026-10-04T11:55:00.000Z", now)).toBe("5m");
    expect(formatIssueAge("2026-10-04T07:00:00.000Z", now)).toBe("5h");
    expect(formatIssueAge("2026-10-01T12:00:00.000Z", now)).toBe("3d");
  });
});
