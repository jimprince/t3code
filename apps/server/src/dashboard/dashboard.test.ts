import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ThreadId, type DashboardProgress, type ProjectIssue } from "@t3tools/contracts";
import { aggregate } from "./aggregation.ts";
import { compactSnapshot, movement, sampleProgress } from "./dashboard.logic.ts";
import { singleFlight } from "./DashboardRefresh.ts";

const now = "2026-10-11T10:00:00.000Z";
const before = "2026-10-11T09:00:00.000Z";
const progress: DashboardProgress = {
  done: 5,
  total: 10,
  planVersion: "v1",
  sourceId: "plan:t3",
  confirmedAt: now,
};
const history = [{ taskId: "task", at: before, done: 2, total: 10, planVersion: "v1" }];

describe("measured movement", () => {
  it("measures step advances and retains samples for the next window", () => {
    expect(movement("task", progress, history, now)).toMatchObject({
      state: "measured",
      doneDelta: 3,
      fromAt: before,
    });
    expect(sampleProgress([], history, now)).toEqual(history);
  });
  it("reports unknown without history or with stale plan confirmation", () => {
    expect(movement("task", progress, [], now).state).toBe("unknown");
    expect(
      movement("task", { ...progress, confirmedAt: "2026-10-10T00:00:00Z" }, history, now).state,
    ).toBe("unknown");
  });
  it("detects replans, including a denominator changed and restored within the hour", () => {
    expect(movement("task", { ...progress, total: 12 }, history, now).state).toBe("replanned");
    expect(
      movement(
        "task",
        progress,
        [...history, { ...history[0]!, at: "2026-10-11T09:30:00Z", total: 12 }],
        now,
      ).state,
    ).toBe("replanned");
  });
});

describe("aggregation", () => {
  it("keeps real plan steps, owner forecast and source confirmation instead of invented percentages", () => {
    const snapshot = aggregate({
      now,
      shells: [],
      metadata: [],
      issues: new Map(),
      sources: [],
      samples: [],
      plans: [
        {
          head: "t3",
          title: "T3",
          updated_utc: before,
          workstreams: [
            {
              id: "release",
              title: "Release",
              tasks: [
                {
                  id: "ship",
                  title: "Ship",
                  kind: "release",
                  link: "",
                  steps_done: 3,
                  steps_total: 8,
                  eta_utc: "2026-10-11T11:00:00Z",
                  next_step: "CI",
                  updated_utc: before,
                },
              ],
            },
          ],
        },
      ],
    });
    const task = snapshot.projects[0]!.tasks[0]!;
    expect(task.progress).toMatchObject({ done: 3, total: 8, confirmedAt: before });
    expect(task.forecast).toEqual({
      eta: "2026-10-11T11:00:00Z",
      basis: "owner",
      sourceId: "plan:t3",
    });
    expect(task.movement.state).toBe("unknown");
    expect(snapshot.projects[0]!.workstreams[0]!.taskIds).toEqual([task.id]);
  });
  it("attaches a decision to its exact task and separates same-number issues on different hosts", () => {
    const root = ThreadId.make("root");
    const makeIssue = (host: string): ProjectIssue => ({
      host,
      repository: "brad/repo",
      number: 1,
      title: "Choose",
      url: `https://${host}/brad/repo/issues/1`,
      status: "pending",
      labels: ["needs-brad"],
      isRequest: false,
      requestSource: null,
      assignees: [],
      comments: 0,
      createdAt: before,
      updatedAt: now,
      closedAt: null,
      linkedThreadIds: [],
      decision: { context: "Which option?", waiting: "root", options: [] },
    });
    const snapshot = aggregate({
      now,
      shells: [{ id: root, title: "T3", archivedAt: null, updatedAt: DateTime.makeUnsafe(now) }],
      metadata: [{ threadId: root, parentThreadId: null, subproject: "on" }],
      issues: new Map([[root, [makeIssue("one.test"), makeIssue("two.test")]]]),
      sources: [],
      plans: [],
      samples: [],
    });
    const project = snapshot.projects[0]!;
    expect(new Set(project.tasks.map((t) => t.id)).size).toBe(2);
    expect(project.attention).toHaveLength(2);
    for (const attention of project.attention)
      expect(project.tasks.find((t) => t.id === attention.taskId)?.attentionIds).toContain(
        attention.id,
      );
    expect(project.attention[0]?.question).toBe("Which option?");
  });
});

describe("aggregation freshness and summary size", () => {
  const plan = (count = 1) => ({
    head: "t3",
    title: "T3",
    updated_utc: now,
    workstreams: [
      {
        id: "work",
        title: "Work",
        tasks: Array.from({ length: count }, (_, i) => ({
          id: `task-${i}`,
          title: "An actual planned deliverable ".repeat(20),
          kind: "feature",
          link: "",
          steps_done: 4,
          steps_total: 8,
          eta_utc: "2026-10-11T11:00:00Z",
          next_step: "Review",
          updated_utc: now,
        })),
      },
    ],
  });
  it("keeps last-good steps but makes movement and forecast unknown after a source failure", () => {
    const snapshot = aggregate({
      now,
      shells: [],
      metadata: [],
      issues: new Map(),
      plans: [plan()],
      sources: [
        {
          id: "plan:t3",
          kind: "plan",
          observedAt: now,
          lastSuccessAt: before,
          staleAfterMs: 7_200_000,
          coverage: "unavailable",
          failed: true,
        },
      ],
      samples: [
        {
          taskId: "plan:t3:task-0",
          at: before,
          done: 1,
          total: 8,
          planVersion: "plan:t3:task-0:8",
        },
      ],
    });
    expect(snapshot.projects[0]!.tasks[0]!.progress?.done).toBe(4);
    expect(snapshot.projects[0]!.tasks[0]!.movement.state).toBe("unknown");
    expect(snapshot.projects[0]!.tasks[0]!.forecast).toBeNull();
  });
  it("bounds a large summary and reports omitted tasks without dangling workstream references", () => {
    const full = aggregate({
      now,
      shells: [],
      metadata: [],
      issues: new Map(),
      plans: [plan(300)],
      sources: [],
      samples: [],
    });
    const summary = compactSnapshot(full);
    expect(new TextEncoder().encode(JSON.stringify(summary)).length).toBeLessThan(95_000);
    const project = summary.projects[0]!;
    expect(project.tasks.length).toBeGreaterThan(0);
    expect(project.tasks.length + project.omittedTaskCount).toBe(300);
    const ids = new Set(project.tasks.map((t) => t.id));
    expect(project.workstreams.flatMap((w) => w.taskIds).every((id) => ids.has(id))).toBe(true);
  });
  it("samples unchanged plans once a minute instead of recording chat activity as movement", () => {
    const snapshot = aggregate({
      now,
      shells: [],
      metadata: [],
      issues: new Map(),
      plans: [plan()],
      sources: [],
      samples: [],
    });
    const task = snapshot.projects[0]!.tasks[0]!;
    const initial = sampleProgress([task], [], now);
    expect(sampleProgress([task], initial, "2026-10-11T10:00:15.000Z")).toEqual(initial);
    expect(sampleProgress([task], initial, "2026-10-11T10:01:00.000Z")).toHaveLength(2);
  });
});

describe("single-flight refresh", () => {
  it.effect("shares one in-flight refresh and allows another after completion", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const refresh = singleFlight(
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return calls;
        }),
      );
      const first = yield* Effect.forkChild(refresh);
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(refresh);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe(1);
      expect(yield* Fiber.join(second)).toBe(1);
      expect(yield* refresh).toBe(2);
    }),
  );
  it.effect("does not poison subsequent refreshes after failure", () =>
    Effect.gen(function* () {
      let calls = 0;
      const refresh = singleFlight(
        Effect.suspend(() => (++calls === 1 ? Effect.fail("offline") : Effect.succeed("fresh"))),
      );
      expect((yield* Effect.exit(refresh))._tag).toBe("Failure");
      expect(yield* refresh).toBe("fresh");
    }),
  );
});
