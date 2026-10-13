import type {
  DashboardAttention,
  DashboardProject,
  DashboardSource,
  DashboardTask,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ANSWER_CAP_MS,
  ANSWER_LINGER_MS,
  ageLabel,
  answerSettled,
  barSegments,
  diffAgainst,
  firstVisitChanges,
  outcomesSince,
  freshnessSuffix,
  mergeSnapshots,
  parseIssueTaskId,
  rankDecisions,
  rollup,
  sourceHealth,
  takeBaseline,
  taskForecast,
  versionState,
} from "./dashboard.logic";

const NOW = Date.parse("2026-10-11T13:42:00.000Z");
const ENV = "env-1" as EnvironmentId;

function task(overrides: Partial<DashboardTask> = {}): DashboardTask {
  return {
    id: "issue:git/o/r#1",
    sourceId: "gitea:git/o/r",
    closedAt: null,
    title: "Task",
    url: null,
    threadId: null,
    workstreamId: "ws",
    status: "working",
    progress: {
      done: 3,
      total: 6,
      planVersion: "v1",
      sourceId: "s",
      confirmedAt: "2026-10-11T13:40:00.000Z",
    },
    movement: {
      state: "measured",
      doneDelta: 1,
      windowMs: 3_600_000,
      fromAt: "2026-10-11T12:40:00.000Z",
      toAt: "2026-10-11T13:42:00.000Z",
    },
    forecast: null,
    nextStep: null,
    attentionIds: [],
    ...overrides,
  };
}

const source = (overrides: Partial<DashboardSource> = {}): DashboardSource => ({
  id: "plan:voice",
  kind: "plan",
  observedAt: "2026-10-11T13:00:00.000Z",
  lastSuccessAt: "2026-10-11T13:30:00.000Z",
  staleAfterMs: 15 * 60_000,
  coverage: "complete",
  failed: false,
  ...overrides,
});

describe("barSegments", () => {
  it("splits done before the window, gained in it and the forecast, as percent of the plan", () => {
    const bar = barSegments({ done: 6, total: 9, gained: 3, projectedDone: 7 });
    expect(bar.done).toBeCloseTo(33.33, 1);
    expect(bar.gained).toBeCloseTo(33.33, 1);
    expect(bar.projected).toBeCloseTo(11.11, 1);
  });

  it("never draws past the plan, and a gain larger than done is capped", () => {
    const bar = barSegments({ done: 2, total: 4, gained: 9, projectedDone: 12 });
    expect(bar.done + bar.gained + bar.projected).toBeLessThanOrEqual(100);
    expect(bar.done).toBe(0);
    expect(bar.gained).toBe(50);
  });

  it("draws nothing for an empty plan or a missing forecast", () => {
    expect(barSegments({ done: 0, total: 0, gained: 0, projectedDone: null })).toEqual({
      done: 0,
      gained: 0,
      projected: 0,
    });
    expect(barSegments({ done: 3, total: 6, gained: 0, projectedDone: null }).projected).toBe(0);
  });
});

describe("taskForecast", () => {
  it("prefers the owner's ETA over pace", () => {
    const owner = { eta: "2026-10-11T17:00:00.000Z", basis: "owner" as const, sourceId: "s" };
    expect(taskForecast(task({ forecast: owner }))).toEqual({ basis: "owner", eta: owner.eta });
  });

  it("projects one more window at the measured pace, capped at the plan", () => {
    expect(taskForecast(task())).toEqual({ basis: "pace", expectedDone: 4 });
    const fast = task({
      movement: { ...task().movement, doneDelta: 9 },
    });
    expect(taskForecast(fast)).toEqual({ basis: "pace", expectedDone: 6 });
  });

  it("has no forecast without history, without movement, or after a replan", () => {
    const unknown = { ...task().movement, state: "unknown" as const, doneDelta: null };
    expect(taskForecast(task({ movement: unknown }))).toBeNull();
    expect(taskForecast(task({ movement: { ...task().movement, doneDelta: 0 } }))).toBeNull();
    expect(
      taskForecast(task({ movement: { ...unknown, state: "replanned" as const } })),
    ).toBeNull();
  });
});

describe("rollup", () => {
  it("sums only tasks with a step list and counts the rest as unplanned", () => {
    const result = rollup([
      task(),
      task({ id: "b", progress: { ...task().progress!, done: 1, total: 4 } }),
      task({ id: "c", progress: null, status: "pending" }),
      task({ id: "d", progress: null, status: "done" }),
    ]);
    expect(result.steps).toEqual({ done: 4, total: 10 });
    expect(result.unplanned).toBe(1);
    expect(result.gained).toBe(2);
    expect(result.projectedDone).toBe(6);
  });

  it("keeps movement unknown when no task was measured, and flags a replan", () => {
    const unknown = { ...task().movement, state: "unknown" as const, doneDelta: null };
    expect(rollup([task({ movement: unknown })]).gained).toBeNull();
    const replanned = rollup([task({ movement: { ...unknown, state: "replanned" } })]);
    expect(replanned.replanned).toBe(true);
    expect(replanned.gained).toBeNull();
  });

  it("reports no bar when nothing has a step list", () => {
    expect(rollup([task({ progress: null, status: "pending" })]).steps).toBeNull();
  });

  it("counts an open plan with a measured zero as idle, the one stall the snapshot proves", () => {
    const idle = task({ movement: { ...task().movement, doneDelta: 0 } });
    expect(rollup([idle, task()]).idle).toBe(1);
    expect(rollup([task({ status: "blocked", movement: idle.movement })]).idle).toBe(0);
  });
});

describe("rankDecisions", () => {
  const item = (id: string, priority: number, deadline: string | null, updatedAt: string) =>
    ({ id, priority, deadline, updatedAt }) as DashboardAttention;

  it("orders by blocking tier, then deadline, then newest", () => {
    const ranked = rankDecisions([
      item("old-other", 3, null, "2026-10-10T00:00:00Z"),
      item("new-other", 3, null, "2026-10-11T00:00:00Z"),
      item("deadline", 2, "2026-10-12T00:00:00Z", "2026-10-09T00:00:00Z"),
      item("release", 0, null, "2026-10-08T00:00:00Z"),
      item("blocks", 1, null, "2026-10-08T00:00:00Z"),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual([
      "release",
      "blocks",
      "deadline",
      "new-other",
      "old-other",
    ]);
  });
});

describe("sources", () => {
  it("is stale past its cadence, failed on error, partial when bounded", () => {
    expect(sourceHealth(source(), NOW)).toBe("fresh");
    expect(sourceHealth(source({ lastSuccessAt: "2026-10-11T12:00:00.000Z" }), NOW)).toBe("stale");
    expect(sourceHealth(source({ lastSuccessAt: null }), NOW)).toBe("stale");
    expect(sourceHealth(source({ failed: true }), NOW)).toBe("failed");
    expect(sourceHealth(source({ coverage: "bounded" }), NOW)).toBe("partial");
  });

  it("names the first stale source in the header suffix", () => {
    expect(freshnessSuffix([source()], NOW)).toBeNull();
    expect(
      freshnessSuffix([source({ lastSuccessAt: "2026-10-11T05:02:00.000Z" })], NOW)?.text,
    ).toBe("Voice tasks stale");
  });
});

describe("since you looked", () => {
  const project = (tasks: DashboardTask[], attention: DashboardAttention[] = []) =>
    ({
      id: "project:a",
      rootThreadId: null,
      parentId: null,
      title: "A",
      utility: false,
      omittedTaskCount: 0,
      workstreams: [],
      sourceIds: [],
      tasks,
      attention,
    }) satisfies DashboardProject;
  const data = (tasks: DashboardTask[], attention: DashboardAttention[] = []) =>
    mergeSnapshots([
      {
        environmentId: ENV,
        snapshot: {
          revision: 1,
          asOf: "2026-10-11T13:42:00.000Z",
          projects: [project(tasks, attention)],
          releases: [],
          sources: [],
        },
      },
    ]);

  it("reports finished work, step advances, replans and new decisions against the baseline", () => {
    const baseline = takeBaseline(
      data([
        task({ id: "finished" }),
        task({ id: "advanced" }),
        task({ id: "replanned" }),
        task({ id: "steady" }),
      ]),
      "2026-10-10T21:58:00.000Z",
    );
    const fresh = { ...task().progress! };
    const now = data(
      [
        task({ id: "finished", status: "done" }),
        task({ id: "advanced", progress: { ...fresh, done: 5 } }),
        task({ id: "replanned", progress: { ...fresh, total: 9 } }),
        task({ id: "steady" }),
        task({ id: "never-seen", status: "done" }),
      ],
      [{ id: "new-decision", title: "Pick", taskId: "steady" } as DashboardAttention],
    );
    const { changes, outcomes } = diffAgainst(now, baseline);
    expect(changes.map((c) => [c.kind, c.taskId])).toEqual([
      ["done", "finished"],
      ["steps", "advanced"],
      ["replanned", "replanned"],
      ["decision-new", "steady"],
    ]);
    expect(outcomes.map((c) => c.taskId)).toEqual(["finished"]);
  });

  it("on a first visit lists open decisions, then work closed in the last day", () => {
    const first = firstVisitChanges(
      data(
        [
          task({ id: "recent", status: "done", closedAt: "2026-10-11T12:00:00.000Z" }),
          task({ id: "older", status: "done", closedAt: "2026-10-09T12:00:00.000Z" }),
          task({ id: "open" }),
        ],
        [{ id: "pick", title: "Pick", taskId: "open" } as DashboardAttention],
      ),
      "2026-10-10T13:42:00.000Z",
    );
    expect(first.map((change) => [change.kind, change.taskId])).toEqual([
      ["decision-new", "open"],
      ["done", "recent"],
    ]);
  });
});

describe("outcomesSince", () => {
  it("lists tasks closed after the cut-off, newest first, and ignores open or undated ones", () => {
    const project = {
      id: "project:a",
      rootThreadId: null,
      parentId: null,
      title: "A",
      utility: false,
      omittedTaskCount: 0,
      workstreams: [],
      sourceIds: [],
      attention: [],
      tasks: [
        task({ id: "old", status: "done", closedAt: "2026-10-10T12:00:00.000Z" }),
        task({ id: "early", status: "done", closedAt: "2026-10-11T10:00:00.000Z" }),
        task({ id: "late", status: "done", closedAt: "2026-10-11T12:00:00.000Z" }),
        task({ id: "undated", status: "done" }),
        task({ id: "open", closedAt: "2026-10-11T12:30:00.000Z" }),
      ],
    } satisfies DashboardProject;
    const data = mergeSnapshots([
      {
        environmentId: ENV,
        snapshot: {
          revision: 1,
          asOf: "2026-10-11T13:42:00.000Z",
          projects: [project],
          releases: [],
          sources: [],
        },
      },
    ]);
    expect(
      outcomesSince(data, "2026-10-11T00:00:00.000Z").map((outcome) => outcome.task.id),
    ).toEqual(["late", "early"]);
  });
});

describe("parseIssueTaskId", () => {
  it("reads host, repository and number", () => {
    expect(parseIssueTaskId("issue:git.example.com/brad/t3code-fork#245")).toEqual({
      host: "git.example.com",
      repository: "brad/t3code-fork",
      number: 245,
    });
    expect(parseIssueTaskId("thread-plan:abc")).toBeNull();
  });
});

describe("ageLabel", () => {
  it("reads minutes, hours and days", () => {
    const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
    expect(ageLabel(at(6), NOW)).toBe("6m");
    expect(ageLabel(at(152), NOW)).toBe("2h 32m");
    expect(ageLabel(at(120), NOW)).toBe("2h");
    expect(ageLabel(at(3 * 24 * 60), NOW)).toBe("3d");
  });
});

describe("answerSettled", () => {
  const sentAt = NOW;
  it("keeps an answer while the snapshot still lists the decision", () => {
    const at = (ms: number) => answerSettled({ sentAt, stillOpen: true, now: NOW + ms });
    expect(at(ANSWER_LINGER_MS)).toBe(false);
    expect(at(ANSWER_CAP_MS - 1)).toBe(false);
  });
  it("lets go of a listed decision at the cap", () => {
    expect(answerSettled({ sentAt, stillOpen: true, now: NOW + ANSWER_CAP_MS })).toBe(true);
  });
  it("lets go once the decision left the snapshot, after the linger", () => {
    expect(answerSettled({ sentAt, stillOpen: false, now: NOW + ANSWER_LINGER_MS - 1 })).toBe(
      false,
    );
    expect(answerSettled({ sentAt, stillOpen: false, now: NOW + ANSWER_LINGER_MS })).toBe(true);
  });
});

describe("versionState", () => {
  it("is unknown without both versions, so no check mark", () => {
    expect(versionState("0.0.46-fork.12", null)).toBe("unknown");
    expect(versionState(null, "v0.0.46-fork.12")).toBe("unknown");
  });
  it("warns only when installed is older than latest", () => {
    expect(versionState("0.0.46-fork.11", "v0.0.46-fork.12")).toBe("behind");
  });
  it("treats the tag's v prefix and an installed build ahead of latest as current", () => {
    expect(versionState("0.0.46-fork.12", "v0.0.46-fork.12")).toBe("current");
    expect(versionState("0.0.46-fork.12", "v0.0.46-fork.11")).toBe("current");
  });
});
