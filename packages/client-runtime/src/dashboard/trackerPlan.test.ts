import { describe, expect, it } from "vite-plus/test";
import { DashboardSnapshot, EnvironmentId, ThreadId, type ProjectIssue } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { aggregate, type BriefingPlan } from "./aggregation.ts";
import { compactSnapshot } from "./progress.ts";
import { mergeDashboardSnapshots } from "./merge.ts";

const decodeSnapshot = Schema.decodeUnknownSync(DashboardSnapshot);
const now = "2026-10-14T10:00:00.000Z";
const root = ThreadId.make("tracker-root");
const makeIssue = (number: number, extra = {}): ProjectIssue => ({
  host: "git.test",
  repository: "brad/repo",
  number,
  title: `Issue ${number}`,
  url: `https://git.test/brad/repo/issues/${number}`,
  status: "pending",
  labels: ["ask", "ask:task"],
  isRequest: true,
  requestSource: null,
  assignees: [],
  comments: 0,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
  linkedThreadIds: [],
  ...extra,
});
const plan = {
  head: "head",
  rootThreadId: root,
  title: "Head",
  source: "tracker",
  updated_utc: now,
  workstreams: [
    {
      id: "old",
      title: "Old",
      tasks: [
        {
          id: "orphan",
          title: "Orphan",
          kind: "feature",
          link: "",
          steps_done: 5,
          steps_total: 9,
          eta_utc: null,
          next_step: "Old action",
          updated_utc: now,
        },
      ],
    },
  ],
} as BriefingPlan;
const { source: _source, ...fallbackPlan } = plan;
const input = (issues: ProjectIssue[], plans: BriefingPlan[] = [plan]) => ({
  shells: [{ ...v2ThreadShell, id: root, title: "Head", archivedAt: null, todoProgress: null }],
  metadata: [{ threadId: root, parentThreadId: null, subproject: "on" as const }],
  issues: new Map([[root, issues]]),
  plans,
  sources: [],
  samples: [],
  now,
});
const summary = {
  done: 1,
  total: 13,
  hasChecklist: true,
  planVersion: "steps:223",
  confirmedAt: now,
  nextStep: "Second",
};

describe("tracker Plan mapping (#297)", () => {
  it("maps personal steps and date-only ETA without linked threads through schema and merge", () => {
    const snapshot = aggregate(input([makeIssue(223, { plan: summary, dueDate: "2026-10-20" })]));
    const decoded = decodeSnapshot(snapshot);
    const task = mergeDashboardSnapshots([
      { environmentId: EnvironmentId.make("dev"), snapshot: decoded },
    ]).projects[0]?.project.tasks[0];
    expect(task?.progress).toMatchObject({
      done: 1,
      total: 13,
      sourceId: "dev:gitea:git.test/brad/repo",
    });
    expect(task?.nextStep).toBe("Second");
    expect(task?.forecast?.eta).toBe("2026-10-20");
  });
  it("ignores the entire flagged JSON, including orphan rows", () => {
    const snapshot = aggregate(input([makeIssue(223, { plan: summary })], [plan]));
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.tasks.map((t) => t.title)).toEqual(["Issue 223"]);
  });
  it("preserves empty epic headings through compaction and namespaces child summaries", () => {
    const snapshot = aggregate(
      input([
        makeIssue(172, {
          plan: { ...summary, done: 0, total: 0, hasChecklist: false },
          epic: { done: 0, total: 0, remaining: [] },
        }),
        makeIssue(155, {
          epic: { done: 10, total: 14, remaining: [153, 179, 170, 114] },
          plan: { ...summary, done: 10, total: 14 },
        }),
        makeIssue(153, {
          partOf: 155,
          epic: { done: 4, total: 5, remaining: [306] },
          plan: { ...summary, done: 4, total: 5 },
        }),
        makeIssue(306, {
          partOf: 153,
          plan: { ...summary, done: 0, total: 1, hasChecklist: false },
        }),
      ]),
    );
    const compact = compactSnapshot(snapshot, 10000);
    const merged = mergeDashboardSnapshots([
      { environmentId: EnvironmentId.make("dev"), snapshot: compact },
    ]);
    const project = merged.projects[0]?.project;
    expect(project?.workstreams.map((w) => w.title)).toContain("Issue 172");
    expect(project?.tasks.map((t) => t.title)).toEqual(["Issue 306"]);
    expect(project?.workstreams.find((w) => w.title === "Issue 155")).toMatchObject({
      progress: { done: 10, total: 14, sourceId: "dev:gitea:git.test/brad/repo" },
    });
  });
  it("keeps open complete checklists out of finished outcomes", () => {
    const task = aggregate(input([makeIssue(223, { plan: { ...summary, done: 13 } })])).projects[0]
      ?.tasks[0];
    expect(task?.progress?.done).toBe(13);
    expect(task?.status).toBe("pending");
    expect(task?.closedAt).toBeNull();
  });
});

it("isolates explicit root cutover within a shared repository and preserves fallback issue identity", () => {
  const second = ThreadId.make("fallback-root");
  const a = makeIssue(223, { linkedThreadIds: [root], plan: summary });
  const b = makeIssue(255, { linkedThreadIds: [second], plan: summary });
  const fallback = {
    ...fallbackPlan,
    head: "fallback",
    title: "Fallback",
    rootThreadId: second,
    workstreams: [
      {
        id: "fallback",
        title: "Fallback",
        tasks: [
          { ...plan.workstreams[0]!.tasks[0]!, link: b.url },
          { ...plan.workstreams[0]!.tasks[0]!, id: "legacy-orphan", link: "" },
        ],
      },
    ],
  };
  const args = {
    ...input([a, b], [plan, fallback]),
    shells: [...input([]).shells, { ...input([]).shells[0]!, id: second, title: "Fallback" }],
    metadata: [
      ...input([]).metadata,
      { threadId: second, parentThreadId: null, subproject: "on" as const },
    ],
    issues: new Map([
      [root, [a, b]],
      [second, [a, b]],
    ]),
  };
  const snapshot = aggregate(args);
  expect(snapshot.projects).toHaveLength(2);
  const fallbackTask = snapshot.projects.find((p) => p.rootThreadId === second)?.tasks[0];
  expect(fallbackTask?.progress).toMatchObject({ done: 5, total: 9, sourceId: "plan:fallback" });
  expect(fallbackTask?.hasChecklist).toBeUndefined();
  const cutover = aggregate({
    ...args,
    plans: [plan],
    trackerRoots: new Set([second]),
    previous: snapshot,
  });
  expect(cutover.projects.find((p) => p.rootThreadId === second)?.tasks[0]).toMatchObject({
    id: fallbackTask!.id,
    progress: { done: 1, total: 13 },
  });
  expect(
    cutover.projects.find((p) => p.rootThreadId === second)?.planMigration?.removedTaskIds,
  ).toEqual(["plan:fallback:legacy-orphan"]);
});

it("retains tracker data with stale evidence and ignores old fallback after the last epic closes", () => {
  const snapshot = aggregate({
    ...input([makeIssue(223, { plan: summary, dueDate: "2026-10-20" })], [fallbackPlan]),
    trackerRoots: new Set([root]),
    sources: [
      {
        id: "gitea:git.test/brad/repo",
        kind: "gitea",
        observedAt: now,
        lastSuccessAt: null,
        staleAfterMs: 120000,
        coverage: "unavailable",
        failed: true,
      },
    ],
  });
  expect(snapshot.projects).toHaveLength(1);
  expect(snapshot.projects[0]?.tasks[0]).toMatchObject({
    progress: { done: 1, total: 13 },
    forecast: null,
    movement: { state: "unknown" },
  });
});

it("decodes old snapshots with absent tracker fields", () => {
  const snapshot = aggregate(input([makeIssue(1)]));
  const { planSource: _source, planMigration: _migration, ...project } = snapshot.projects[0]!;
  const old = decodeSnapshot({
    ...snapshot,
    projects: [
      {
        ...project,
        workstreams: project.workstreams.map((w) => ({
          id: w.id,
          title: w.title,
          taskIds: w.taskIds,
        })),
      },
    ],
  });
  expect(old.projects[0]?.tasks[0]?.progress).toBeNull();
  expect(old.projects[0]?.planSource).toBeUndefined();
  expect(old.projects[0]?.workstreams[0]?.progress).toBeUndefined();
});

it("keeps an unflagged root on briefing even with a tracker epic", () => {
  const snapshot = aggregate(
    input(
      [
        makeIssue(172, {
          labels: ["ask", "ask:epic"],
          epic: { done: 0, total: 0, remaining: [] },
          plan: { ...summary, done: 0, total: 0 },
        }),
      ],
      [fallbackPlan],
    ),
  );
  expect(snapshot.projects).toHaveLength(1);
  expect(snapshot.projects[0]?.planSource).toBe("briefing");
  expect(
    snapshot.projects[0]?.tasks.find((task) => task.id.startsWith("plan:"))?.progress,
  ).toMatchObject({ done: 5, total: 9 });
  expect(
    snapshot.projects[0]?.tasks.find((task) => task.id.endsWith("#172"))?.progress,
  ).toMatchObject({ planVersion: "epic:0" });
});

it("routes review and test to Brad even for legacy non-ask labels, while release waits stay with the owner", () => {
  const snapshot = aggregate(
    input([
      makeIssue(294, { labels: ["needs-review"], isRequest: false }),
      makeIssue(202, { labels: ["needs-test"], isRequest: false }),
      makeIssue(307, { labels: ["awaiting-release"], stage: "awaiting-release" }),
      makeIssue(146, { labels: ["awaiting-release"], stage: "awaiting-release" }),
    ]),
  );
  expect(snapshot.projects[0]?.attention.map((card) => [card.kind, card.taskId])).toEqual([
    ["review", "issue:git.test/brad/repo#294"],
    ["test", "issue:git.test/brad/repo#202"],
  ]);
  expect(
    snapshot.projects[0]?.tasks.find((task) => task.id.endsWith("#294"))?.attentionIds,
  ).toEqual(["issue:git.test/brad/repo#294:attention"]);
});

it("keeps an epic link and execution thread on its header without adding its steps to task totals", () => {
  const snapshot = aggregate(
    input([
      makeIssue(172, {
        linkedThreadIds: [root],
        plan: { ...summary, done: 0, total: 0 },
        epic: { done: 0, total: 0, remaining: [] },
      }),
    ]),
  );
  expect(snapshot.projects[0]?.tasks).toHaveLength(0);
  expect(snapshot.projects[0]?.workstreams[0]).toMatchObject({
    url: "https://git.test/brad/repo/issues/172",
    threadId: root,
  });
});

it("bounds header-only snapshots and reports omitted workstreams", () => {
  const snapshot = aggregate(
    input(
      Array.from({ length: 100 }, (_, i) =>
        makeIssue(i + 1, {
          title: "Long workstream title ".repeat(10),
          epic: { done: 0, total: 0, remaining: [] },
          plan: { ...summary, done: 0, total: 0, hasChecklist: false },
        }),
      ),
    ),
  );
  const compact = compactSnapshot(snapshot, 4000);
  expect(new TextEncoder().encode(JSON.stringify(compact)).length).toBeLessThanOrEqual(4000);
  expect(compact.projects[0]?.workstreams.length).toBeGreaterThan(0);
  expect(compact.projects[0]?.omittedWorkstreamCount).toBeGreaterThan(0);
});

it("preserves a waiting decision before empty headers consume the wire budget", () => {
  const headers = Array.from({ length: 100 }, (_, i) =>
    makeIssue(i + 1, {
      title: "Long workstream title ".repeat(10),
      epic: { done: 0, total: 0, remaining: [] },
      plan: { ...summary, done: 0, total: 0, hasChecklist: false },
    }),
  );
  const snapshot = aggregate(
    input([...headers, makeIssue(999, { labels: ["needs-review"], isRequest: false })]),
  );
  const compact = compactSnapshot(snapshot, 4000);
  expect(compact.projects[0]?.attention.map((card) => card.taskId)).toContain(
    "issue:git.test/brad/repo#999",
  );
  expect(new TextEncoder().encode(JSON.stringify(compact)).length).toBeLessThanOrEqual(4000);
});

it("preserves membership warnings through the shared wire projection", () => {
  const snapshot = decodeSnapshot(
    aggregate(input([makeIssue(1, { plan: summary, membershipWarnings: ["malformed-parent"] })])),
  );
  expect(snapshot.projects[0]?.tasks[0]?.membershipWarnings).toEqual(["malformed-parent"]);
});

it("prevents an unbound legacy file from overriding a tracker-owned linked issue", () => {
  const legacy = {
    ...fallbackPlan,
    head: "unbound",
    title: "Unbound legacy head",
    rootThreadId: undefined,
    workstreams: [
      {
        ...fallbackPlan.workstreams[0]!,
        tasks: [
          {
            ...fallbackPlan.workstreams[0]!.tasks[0]!,
            link: "https://git.test/brad/repo/issues/223",
          },
        ],
      },
    ],
  };
  const { rootThreadId: _root, ...unbound } = legacy;
  const snapshot = aggregate(input([makeIssue(223, { plan: summary })], [plan, unbound]));
  expect(snapshot.projects.find((p) => p.rootThreadId === root)?.tasks[0]?.progress).toMatchObject({
    done: 1,
    total: 13,
    sourceId: "gitea:git.test/brad/repo",
  });
});

it("keeps linked issue progress on a bound JSON root (#297 B3)", () => {
  const args = input([makeIssue(1, { linkedThreadIds: [root], plan: summary })], [fallbackPlan]);
  const project = aggregate({
    ...args,
    shells: args.shells.map((shell) => ({ ...shell, todoProgress: { completed: 2, total: 5 } })),
  }).projects[0]!;
  expect(project.tasks.find((t) => t.url?.endsWith("/1"))?.progress).toMatchObject({
    done: 2,
    total: 5,
  });
  expect(project.planSource).toBe("briefing");
});

it("requires an explicit matching root id and flag; missing or renamed files never cut over (#297 B4)", () => {
  const issue = makeIssue(1, { plan: summary });
  const { rootThreadId: _id, ...withoutId } = plan;
  for (const files of [
    [],
    [withoutId],
    [{ ...withoutId, title: "Renamed" }],
    [{ ...plan, rootThreadId: ThreadId.make("wrong-root"), title: "Renamed" }],
  ]) {
    const snapshot = aggregate(input([issue], files));
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.planSource).toBe("briefing");
    expect(snapshot.projects[0]?.tasks.find((t) => t.url === issue.url)?.progress).toBeNull();
    if (files.length && files[0]?.title === "Renamed")
      expect(snapshot.planMigration).toMatchObject([
        { kind: "unbound-briefing-file", fileName: `${files[0]!.head}.json` },
      ]);
  }
});

it("preserves unflagged unbound head projects without migration warnings (#297 v1.4)", () => {
  const { rootThreadId: _id, ...legacy } = fallbackPlan;
  for (const head of ["head", root]) {
    const snapshot = aggregate(input([], [{ ...legacy, head, title: "Renamed head" }]));
    expect(snapshot.planMigration).toBeUndefined();
    expect(snapshot.projects).toHaveLength(2);
    const ownHead = snapshot.projects.find((p) => p.id === `head:${head}`);
    expect(ownHead?.rootThreadId).toBeNull();
    expect(ownHead?.tasks[0]?.title).toBe("Orphan");
    expect(ownHead?.tasks[0]?.progress).toMatchObject({ done: 5, total: 9 });
    expect(snapshot.projects.find((p) => p.rootThreadId === root)?.planSource).toBe("briefing");
  }
});

it("retains cross-root JSON rows with their JSON owner (#297 S1)", () => {
  const second = ThreadId.make("json-owner");
  const issue = makeIssue(1, { linkedThreadIds: [root], plan: summary });
  const ownPlan = {
    ...fallbackPlan,
    rootThreadId: second,
    head: "json",
    workstreams: [
      { ...plan.workstreams[0]!, tasks: [{ ...plan.workstreams[0]!.tasks[0]!, link: issue.url }] },
    ],
  };
  const args = input([issue], [plan, ownPlan]);
  const snapshot = aggregate({
    ...args,
    shells: [...args.shells, { ...args.shells[0]!, id: second }],
    metadata: [...args.metadata, { threadId: second, parentThreadId: null, subproject: "on" }],
  });
  expect(
    snapshot.projects
      .find((p) => p.rootThreadId === second)
      ?.tasks.some((t) => t.id === "plan:json:orphan"),
  ).toBe(true);
  expect(snapshot.projects.find((p) => p.rootThreadId === root)?.tasks[0]?.progress?.done).toBe(1);
});

it("keeps the strongest same-evidence clock across shared roots (#297 N6)", () => {
  const second = ThreadId.make("same-repo");
  const issue = makeIssue(1, { linkedThreadIds: [root], plan: summary });
  const args = input([issue]);
  const snapshot = aggregate({
    ...args,
    shells: [...args.shells, { ...args.shells[0]!, id: second }],
    metadata: [...args.metadata, { threadId: second, parentThreadId: null, subproject: "on" }],
    issues: new Map([
      [root, [issue]],
      [second, [{ ...issue, plan: { ...summary, confirmedAt: null } }]],
    ]),
  });
  expect(snapshot.projects.find((p) => p.rootThreadId === root)?.tasks[0]?.progress).toMatchObject({
    confirmedAt: now,
    confirmationKnown: true,
  });
});

it("keeps awaiting-release out of Brad review even with a stale review label (#297 N7)", () => {
  const snapshot = aggregate(
    input([
      makeIssue(1, {
        stage: "awaiting-release",
        labels: ["ask:task", "needs-review", "awaiting-release"],
        plan: summary,
      }),
    ]),
  );
  expect(snapshot.projects[0]?.attention).toHaveLength(0);
});

it("uses tracker steps instead of linked native steps only after explicit cutover (#297 B3 twin)", () => {
  const args = input([makeIssue(1, { linkedThreadIds: [root], plan: summary })], [plan]);
  const project = aggregate({
    ...args,
    shells: args.shells.map((shell) => ({ ...shell, todoProgress: { completed: 2, total: 5 } })),
  }).projects[0]!;
  expect(project.tasks.find((t) => t.url?.endsWith("/1"))?.progress).toMatchObject({
    done: 1,
    total: 13,
  });
  expect(project.planSource).toBe("tracker");
});

it("exposes structured unbound-file warnings through wire and merge without a duplicate project (#297 B4 addendum)", () => {
  const { rootThreadId: _id, ...legacy } = fallbackPlan;
  const unbound = {
    ...legacy,
    source: "tracker" as const,
    title: "Renamed head",
    fileName: "renamed-head.json",
  };
  const snapshot = aggregate(input([], [unbound]));
  const wire = decodeSnapshot(JSON.parse(JSON.stringify(snapshot)));
  expect(wire.planMigration).toEqual([
    {
      kind: "unbound-briefing-file",
      fileName: "renamed-head.json",
      reason: "No unique exact-title binding",
    },
  ]);
  expect(wire.projects).toHaveLength(1);
  const merged = mergeDashboardSnapshots([
    { environmentId: EnvironmentId.make("dev"), snapshot: wire },
  ]);
  expect(merged.planMigration).toEqual([{ ...wire.planMigration![0], environmentId: "dev" }]);
  const { planMigration: _migration, ...old } = wire;
  expect(decodeSnapshot(old).planMigration).toBeUndefined();
});

it.each([2, 9])("keeps %i unmatched JSON heads distinct (#297 R2-B1)", (count) => {
  const { rootThreadId: _root, ...legacy } = fallbackPlan;
  const plans = Array.from({ length: count }, (_, i) => ({
    ...legacy,
    head: `unmatched-${i}`,
    title: `Unmatched head ${i}`,
    workstreams: [
      {
        ...legacy.workstreams[0]!,
        tasks: [{ ...legacy.workstreams[0]!.tasks[0]!, title: `Task ${i}` }],
      },
    ],
  }));
  const snapshot = aggregate(input([], plans));
  expect(snapshot.planMigration).toBeUndefined();
  expect(snapshot.projects.filter((p) => p.id.startsWith("head:"))).toHaveLength(count);
  for (let i = 0; i < count; i++) {
    const project = snapshot.projects.find((p) => p.id === `head:unmatched-${i}`);
    expect(project?.title).toBe(`Unmatched head ${i}`);
    expect(project?.tasks.map((t) => t.title)).toEqual([`Task ${i}`]);
  }
});

it("uses linked todo for an inferred epic only on JSON roots (#297 R2-S1)", () => {
  const issue = makeIssue(1, {
    linkedThreadIds: [root],
    epic: { done: 1, total: 2, remaining: [3], children: [2, 3] },
    plan: { ...summary, done: 1, total: 2 },
  });
  const args = input([issue], [fallbackPlan]);
  const shells = args.shells.map((s) => ({ ...s, todoProgress: { completed: 4, total: 7 } }));
  const legacy = aggregate({ ...args, shells }).projects[0]!;
  expect(legacy.tasks.find((t) => t.url === issue.url)?.progress).toMatchObject({
    done: 4,
    total: 7,
  });
  expect(legacy.tasks.filter((t) => t.id.startsWith("thread-plan:"))).toHaveLength(0);
  const tracker = aggregate({ ...args, shells, plans: [plan] }).projects[0]!;
  expect(tracker.workstreams.find((w) => w.url === issue.url)?.progress).toMatchObject({
    done: 1,
    total: 2,
  });
});

it("uses the separately preserved labelled-epic and canonical parent on JSON roots (#297 R2-S1)", () => {
  const issue = makeIssue(1, {
    labels: ["ask:epic"],
    epic: { done: 1, total: 1, remaining: [] },
    briefingEpic: { done: 2, total: 2, remaining: [] },
    partOf: 8,
    briefingPartOf: null,
    plan: { ...summary, done: 1, total: 1 },
  });
  const snapshot = aggregate(input([issue], [fallbackPlan]));
  const wire = decodeSnapshot(JSON.parse(JSON.stringify(snapshot)));
  expect(wire.projects[0]?.tasks.find((t) => t.url === issue.url)?.progress).toMatchObject({
    done: 2,
    total: 2,
  });
  expect(wire.projects[0]?.tasks.find((t) => t.url === issue.url)?.partOf).toBeUndefined();
  const { briefingEpic: _epic, briefingPartOf: _parent, ...oldIssue } = issue;
  expect(
    aggregate(input([oldIssue], [fallbackPlan])).projects[0]?.tasks[0]?.progress,
  ).toMatchObject({ done: 1, total: 1 });
});
