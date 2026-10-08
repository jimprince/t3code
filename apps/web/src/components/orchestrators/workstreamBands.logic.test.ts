import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BlockedRow } from "./projectWork.logic";
import {
  bandOpensByDefault,
  blockedNotes,
  deriveBands,
  firstLine,
  isAfter,
  milestoneLabel,
} from "./workstreamBands.logic";
import type { TaskStatus } from "./projectRequests.logic";

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

const epic = (number: number, done: number, total: number, remaining: number[]) =>
  issue(number, { epic: { done, total, remaining }, status: "in-progress" });

const thread = (
  id: string,
  overrides: { working?: boolean; output?: string; createdAt?: string; completedAt?: string } = {},
) =>
  ({
    id,
    title: `Thread ${id}`,
    archivedAt: null,
    settledOverride: null,
    updatedAt: "2026-10-03T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-10-01T00:00:00.000Z",
    runtime: { status: overrides.working ? "running" : "idle" },
    pendingBackgroundTasks: [],
    codexNativeGoal: null,
    latestRun: overrides.completedAt ? { completedAt: overrides.completedAt } : null,
    source: { workerSummary: overrides.output ? { output: overrides.output } : undefined },
  }) as unknown as OrchestratorThreadShell;

const derive = (
  issues: ProjectIssue[],
  statuses: [string, TaskStatus][] = [],
  threads: OrchestratorThreadShell[] = [],
  since?: string,
  taskNotes?: ReadonlyMap<string, string>,
) =>
  deriveBands({
    issues,
    statuses: new Map(statuses.map(([number, status]) => [`brad/repo#${number}`, status])),
    threadsById: new Map(threads.map((t) => [t.id as string, t])),
    rootThreadId: "root",
    since: since ?? null,
    ...(taskNotes ? { taskNotes } : {}),
  });

describe("deriveBands", () => {
  it("puts an epic's parts under it and everything else in one trailing band", () => {
    const bands = derive([
      epic(10, 1, 3, [11, 12]),
      issue(11, { partOf: 10 }),
      issue(12, { partOf: 10 }),
      issue(20),
    ]);
    expect(bands.map((band) => band.key)).toEqual(["brad/repo#10", "other"]);
    expect(bands[0]!.rows.map((row) => row.issue.number)).toEqual([11, 12]);
    expect(bands[0]!.progress).toBe("1 of 3 · Building");
    expect(bands[1]!.rows.map((row) => row.issue.number)).toEqual([20]);
  });

  it("sorts rows For review, Active, Pending and folds Complete apart", () => {
    const [band] = derive(
      [
        epic(10, 1, 4, [11, 12, 13]),
        issue(11, { partOf: 10 }),
        issue(12, { partOf: 10 }),
        issue(13, { partOf: 10 }),
        issue(14, { partOf: 10, closedAt: "2026-10-04T00:00:00.000Z", status: "done" }),
      ],
      [
        ["11", "pending"],
        ["12", "for-review"],
        ["13", "active"],
        ["14", "complete"],
      ],
    );
    expect(band!.rows.map((row) => row.status)).toEqual(["for-review", "active", "pending"]);
    expect(band!.complete.map((row) => row.issue.number)).toEqual([14]);
    expect(band!.needsYou).toBe(1);
  });

  it("lists bands that wait on Brad first, then ones with agents working", () => {
    const bands = derive(
      [
        epic(10, 0, 1, [11]),
        issue(11, { partOf: 10 }),
        epic(20, 0, 1, [21]),
        issue(21, { partOf: 20, linkedThreadIds: ["w"] as never }),
        epic(30, 0, 1, [31]),
        issue(31, { partOf: 30 }),
      ],
      [
        ["31", "for-review"],
        ["21", "active"],
      ],
      [thread("w", { working: true })],
    );
    expect(bands.map((band) => band.epic?.number)).toEqual([30, 20, 10]);
    expect(bands[1]!.agentsWorking).toBe(1);
  });

  it("reads Latest from the working thread's own words before the issue comment", () => {
    const [band] = derive(
      [
        epic(10, 0, 1, [11]),
        issue(11, {
          partOf: 10,
          linkedThreadIds: ["w"] as never,
          latestComment: {
            author: "a",
            body: "Stale owner note",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        }),
      ],
      [["11", "active"]],
      [thread("w", { working: true, output: "Ordering fix passes all 10 tests.\nMore detail." })],
    );
    expect(band!.rows[0]!.latest).toBe("Ordering fix passes all 10 tests.");
    expect(band!.rows[0]!.agents).toEqual([{ threadId: "w", title: "Thread w", working: true }]);
  });

  it("marks a task blocked only while the issue it waits on is still open", () => {
    const [band] = derive([
      epic(10, 0, 2, [11, 12]),
      issue(11, { partOf: 10 }),
      issue(12, { partOf: 10, blockedBy: [11, 99] }),
    ]);
    expect(band!.rows.find((row) => row.issue.number === 12)!.blockedBy).toEqual([11]);
    expect(band!.blocked).toBe(1);
  });

  it("summarises what changed since the previous visit", () => {
    const [band] = derive(
      [
        epic(10, 0, 2, [11, 12]),
        issue(11, {
          partOf: 10,
          status: "done",
          closedAt: "2026-10-05T00:00:00.000Z",
          linkedThreadIds: ["a", "b"] as never,
        }),
        issue(12, { partOf: 10 }),
      ],
      [["11", "complete"]],
      [
        thread("a", {
          createdAt: "2026-10-05T00:00:00.000Z",
          completedAt: "2026-10-05T01:00:00.000Z",
        }),
        thread("b", { createdAt: "2026-10-01T00:00:00.000Z" }),
      ],
      "2026-10-04T00:00:00.000Z",
    );
    expect(band!.changes).toBe("#11 closed · 1 agent started · 1 finished");
  });

  it("lists a parked epic as a task of the last band and leaves archived tasks out", () => {
    const bands = derive([
      { ...epic(10, 0, 1, [11]), labels: ["parked"] } as ProjectIssue,
      issue(11, { partOf: 10 }),
      issue(20, { status: "archived" }),
    ]);
    expect(bands.map((band) => band.epic?.number ?? null)).toEqual([null]);
    expect(bands[0]!.rows.map((row) => row.issue.number)).toEqual([10, 11]);
  });

  it("takes an epic's open tasks from its checklist even without a 'Part of' line", () => {
    const [band] = derive([epic(10, 0, 1, [11]), issue(11)]);
    expect(band!.rows.map((row) => row.issue.number)).toEqual([11]);
  });

  it("counts a thread linked to the epic itself among the band's working agents", () => {
    const [band] = derive(
      [
        { ...epic(10, 0, 1, [11]), linkedThreadIds: ["owner"] } as unknown as ProjectIssue,
        issue(11, { partOf: 10 }),
      ],
      [],
      [thread("owner", { working: true })],
    );
    expect(band!.agentsWorking).toBe(1);
  });

  it("marks a task blocked from the Blocked rows' stuck note", () => {
    const stuck: BlockedRow = {
      key: "stuck:brad/repo#11",
      kind: "stuck",
      title: "Issue 11",
      cause: "Stuck 4d",
      owner: null,
      next: null,
      action: null,
    };
    const [band] = derive(
      [epic(10, 0, 1, [11]), issue(11, { partOf: 10 })],
      [["11", "active"]],
      [],
      undefined,
      blockedNotes([stuck]).tasks,
    );
    expect(band!.rows[0]!.blockedNote).toBe("blocked, stuck 4d");
    expect(band!.blocked).toBe(1);
  });

  it("leaves the orchestrator and archived threads out of the changes line", () => {
    const archived = {
      ...thread("old", { createdAt: "2026-10-05T00:00:00.000Z" }),
      archivedAt: "2026-10-06T00:00:00.000Z",
    } as unknown as OrchestratorThreadShell;
    const [band] = derive(
      [
        { ...epic(10, 0, 1, [11]), linkedThreadIds: ["root"] } as unknown as ProjectIssue,
        issue(11, { partOf: 10, linkedThreadIds: ["old"] as never }),
      ],
      [],
      [
        thread("root", {
          createdAt: "2026-10-05T00:00:00.000Z",
          completedAt: "2026-10-05T01:00:00.000Z",
        }),
        archived,
      ],
      "2026-10-04T00:00:00.000Z",
    );
    expect(band!.changes).toBeNull();
  });
});

describe("isAfter", () => {
  it("compares instants, not strings, so a local UTC offset does not misorder them", () => {
    expect(isAfter("2026-10-04T23:00:00-06:00", "2026-10-05T00:00:00Z")).toBe(true);
    expect("2026-10-04T23:00:00-06:00" > "2026-10-05T00:00:00Z").toBe(false);
  });
});

describe("bandOpensByDefault", () => {
  const band = (overrides: { needsYou?: number; agentsWorking?: number }) =>
    ({ needsYou: 0, agentsWorking: 0, ...overrides }) as Parameters<typeof bandOpensByDefault>[0];

  it("opens a band that waits on Brad or has agents working, and a lone band", () => {
    expect(bandOpensByDefault(band({ needsYou: 1 }), 3)).toBe(true);
    expect(bandOpensByDefault(band({ agentsWorking: 1 }), 3)).toBe(true);
    expect(bandOpensByDefault(band({}), 1)).toBe(true);
    expect(bandOpensByDefault(band({}), 3)).toBe(false);
  });
});

describe("milestoneLabel", () => {
  const tagged = (title: string | null) =>
    issue(1, title === null ? {} : { milestone: { id: 1, title } as never });

  it("names the earliest milestone out of the range the open tasks carry", () => {
    expect(milestoneLabel([tagged("M2"), tagged("M10"), tagged("M1")])).toBe("M1 of M1-M10");
    expect(milestoneLabel([tagged("M3"), tagged(null)])).toBe("M3");
    expect(milestoneLabel([tagged(null)])).toBeNull();
  });

  it("is shown on a band for the open tasks only", () => {
    const [band] = derive([
      epic(10, 1, 3, [11, 12]),
      issue(11, { partOf: 10, milestone: { id: 1, title: "M2" } as never }),
      issue(12, { partOf: 10, milestone: { id: 2, title: "M3" } as never }),
    ]);
    expect(band!.milestone).toBe("M2 of M2-M3");
  });
});

describe("firstLine", () => {
  it("takes the first sentence-bearing line and trims markdown markers", () => {
    expect(firstLine("\n## Result\nBody")).toBe("Result");
  });

  it("cuts a long line at a word boundary", () => {
    const cut = firstLine("word ".repeat(60), 40)!;
    expect(cut.length).toBeLessThanOrEqual(41);
    expect(cut.endsWith("…")).toBe(true);
  });
});
