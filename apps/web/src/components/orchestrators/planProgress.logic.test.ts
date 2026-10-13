import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import { ThreadId, type ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePlanWorkstreams,
  parseUtilityTitles,
  planTotals,
  planWindowStart,
  taskFraction,
} from "./planProgress.logic";
import type { TaskStatus } from "./projectRequests.logic";
import type { Band, BandRow } from "./workstreamBands.logic";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const HOUR_AGO = NOW - 60 * 60 * 1000;

const issue = (number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue =>
  ({
    host: "git.example",
    repository: "brad/app",
    number,
    title: `Task ${number}`,
    url: `https://git.example/brad/app/issues/${number}`,
    status: "in-progress",
    labels: [],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  }) as ProjectIssue;

const row = (task: ProjectIssue, status: TaskStatus): BandRow => ({
  issue: task,
  status,
  agents: [],
  latest: null,
  blockedBy: [],
  blockedNote: null,
});

const band = (rows: BandRow[], epic: ProjectIssue | null = issue(1)): Band => ({
  key: epic ? `brad/app#${epic.number}` : "other",
  epic,
  rows: rows.filter((item) => item.status !== "complete"),
  complete: rows.filter((item) => item.status === "complete"),
  needsYou: 0,
  agentsWorking: 0,
  blocked: 0,
  progress: null,
  milestone: null,
  changes: null,
});

const thread = (
  id: string,
  updatedAt: string,
  todoProgress: { completed: number; total: number } | null = null,
): OrchestratorThreadShell =>
  ({
    id,
    updatedAt,
    runtime: { status: todoProgress ? "running" : "idle" },
    pendingBackgroundTasks: [],
    codexNativeGoal: null,
    todoProgress,
  }) as unknown as OrchestratorThreadShell;

describe("taskFraction", () => {
  it("fills under-way tasks from their to-do list, short of review", () => {
    expect(taskFraction("complete", null)).toBe(1);
    expect(taskFraction("for-review", null)).toBe(0.9);
    expect(taskFraction("pending", null)).toBe(0);
    expect(taskFraction("active", null)).toBe(0.1);
    expect(taskFraction("active", { completed: 4, total: 4 })).toBe(0.9);
    expect(taskFraction("active", { completed: 2, total: 4 })).toBeCloseTo(0.45);
  });
});

describe("derivePlanWorkstreams", () => {
  it("counts tasks closed inside the window as movement and projects that pace one window on", () => {
    const [stream] = derivePlanWorkstreams({
      bands: [
        band([
          row(issue(2, { closedAt: "2026-10-10T11:30:00Z" }), "complete"),
          row(issue(3, { closedAt: "2026-10-09T09:00:00Z" }), "complete"),
          row(issue(4), "pending"),
          row(issue(5), "pending"),
        ]),
      ],
      threadsById: new Map(),
      windowStart: HOUR_AGO,
    });
    expect(stream!.fraction).toBe(0.5);
    expect(stream!.gained).toBe(0.25);
    expect(stream!.projected).toBe(0.25);
    expect(stream!.doneInWindow).toBe(1);
    // Open tasks are listed before finished ones.
    expect(stream!.tasks.map((task) => task.issue.number)).toEqual([4, 5, 2, 3]);
  });

  it("caps the projection at what is left", () => {
    const [stream] = derivePlanWorkstreams({
      bands: [
        band([
          row(issue(2, { closedAt: "2026-10-10T11:30:00Z" }), "complete"),
          row(issue(3, { closedAt: "2026-10-10T11:40:00Z" }), "complete"),
          row(issue(4), "for-review"),
        ]),
      ],
      threadsById: new Map(),
      windowStart: HOUR_AGO,
    });
    expect(stream!.fraction + stream!.projected).toBeCloseTo(1);
    expect(stream!.waitingOnYou).toBe(1);
  });

  it("marks an under-way task and its workstream stalled when nothing moved in the window", () => {
    const linked = issue(2, { linkedThreadIds: [ThreadId.make("worker")] });
    const quiet = new Map([["worker", thread("worker", "2026-10-10T09:00:00Z")]]);
    const [stalled] = derivePlanWorkstreams({
      bands: [band([row(linked, "active")])],
      threadsById: quiet,
      windowStart: HOUR_AGO,
    });
    expect(stalled!.stalled).toBe(true);
    expect(stalled!.tasks[0]!.stalled).toBe(true);

    const busy = new Map([
      ["worker", thread("worker", "2026-10-10T11:55:00Z", { completed: 1, total: 2 })],
    ]);
    const [moving] = derivePlanWorkstreams({
      bands: [band([row(linked, "active")])],
      threadsById: busy,
      windowStart: HOUR_AGO,
    });
    expect(moving!.stalled).toBe(false);
    expect(moving!.tasks[0]!.steps).toEqual({ completed: 1, total: 2 });
    expect(moving!.tasks[0]!.fraction).toBeCloseTo(0.45);
  });

  it("leaves out workstreams with nothing open", () => {
    expect(
      derivePlanWorkstreams({
        bands: [band([row(issue(2, { closedAt: "2026-10-10T11:30:00Z" }), "complete")])],
        threadsById: new Map(),
        windowStart: HOUR_AGO,
      }),
    ).toEqual([]);
  });
});

describe("planTotals", () => {
  it("weights workstreams by their task counts", () => {
    const streams = derivePlanWorkstreams({
      bands: [
        band([row(issue(2), "pending")], issue(1)),
        band(
          [
            row(issue(11, { closedAt: "2026-10-10T11:30:00Z" }), "complete"),
            row(issue(12, { closedAt: "2026-10-09T11:30:00Z" }), "complete"),
            row(issue(13), "pending"),
          ],
          issue(10),
        ),
      ],
      threadsById: new Map(),
      windowStart: HOUR_AGO,
    });
    const totals = planTotals(streams);
    expect(totals.fraction).toBe(0.5);
    expect(totals.gained).toBe(0.25);
    expect(totals.doneInWindow).toBe(1);
  });
});

describe("planWindowStart", () => {
  it("measures today from local midnight", () => {
    const start = new Date(planWindowStart("today", NOW));
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    expect(planWindowStart("4h", NOW)).toBe(NOW - 4 * 60 * 60 * 1000);
  });
});

describe("parseUtilityTitles", () => {
  it("reads one title per line, case-blind", () => {
    expect([...parseUtilityTitles(" Quota Orchestrator \n\nreliability")]).toEqual([
      "quota orchestrator",
      "reliability",
    ]);
    expect(parseUtilityTitles(undefined).size).toBe(0);
  });
});
