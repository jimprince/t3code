import { describe, expect, it } from "vite-plus/test";
import { DashboardSnapshot, EnvironmentId, ThreadId, type ProjectIssue } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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

const oldHead = ThreadId.make("c7da3448-db80-4c1a-8454-3a6859305370");
const nextHead = ThreadId.make("next-head");
const t3Head = ThreadId.make("t3-head");
const dashHead = ThreadId.make("dash-head");
const worker = ThreadId.make("worker");
const handoverInput = (settled = false) => {
  const ids = [t3Head, oldHead, nextHead, dashHead, worker];
  const issues = [
    makeIssue(1, { requestSource: { threadId: oldHead, rootThreadId: oldHead, messageId: "m" } }),
    makeIssue(2, { requestSource: { threadId: worker, rootThreadId: oldHead, messageId: "m" } }),
    makeIssue(3, { linkedThreadIds: [oldHead, t3Head] }),
    makeIssue(4, { linkedThreadIds: [oldHead, dashHead] }),
    makeIssue(5, { linkedThreadIds: [oldHead] }),
    makeIssue(6, {
      owner: { threadId: oldHead, title: "Old", projectTitle: "Product" },
      requestSource: { threadId: oldHead, rootThreadId: oldHead, messageId: "m" },
    }),
    makeIssue(7, { decision: { waiting: oldHead, options: [], context: "Decide" } }),
  ];
  return {
    ...input(issues, [
      { ...plan, rootThreadId: nextHead, predecessorRootThreadIds: [oldHead] } as BriefingPlan,
    ]),
    shells: ids.map((id) => ({
      ...v2ThreadShell,
      id,
      title: id,
      archivedAt: null,
      todoProgress: null,
      settledOverride: id === oldHead && settled ? ("settled" as const) : null,
    })),
    metadata: ids.map((threadId) => ({
      threadId,
      parentThreadId: threadId === t3Head ? null : threadId === worker ? nextHead : t3Head,
      subproject: threadId === worker ? ("auto" as const) : ("on" as const),
    })),
    issues: new Map(ids.map((id) => [id, issues])),
    trackerRoots: new Set([oldHead, nextHead]),
  };
};

describe("tracker head handover (#370)", () => {
  it.each([false, true])("canonicalizes ownership before exclusion (old settled=%s)", (settled) => {
    const snapshot = aggregate(handoverInput(settled));
    expect(snapshot.projects.some((p) => p.rootThreadId === oldHead)).toBe(false);
    const owner = (n: number) =>
      snapshot.projects.find((p) => p.tasks.some((t) => t.title === `Issue ${n}`))?.rootThreadId;
    for (const n of [1, 2, 3, 5, 6, 7]) expect(owner(n), `issue ${n}`).toBe(nextHead);
    expect(owner(4)).toBe(dashHead);
    const keys = snapshot.projects.flatMap((p) => p.tasks.map((t) => t.id));
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("ignores a doubly claimed predecessor and reports a migration warning", () => {
    const data = handoverInput();
    data.plans.push({
      ...plan,
      fileName: "other.json",
      rootThreadId: dashHead,
      predecessorRootThreadIds: [oldHead],
    } as BriefingPlan);
    const snapshot = aggregate(data);
    expect(snapshot.projects.some((p) => p.rootThreadId === oldHead)).toBe(true);
    expect(snapshot.planMigration?.some((w) => /claimed/i.test(w.reason))).toBe(true);
  });
  it("rejects a predecessor with its own current flagged file", () => {
    const data = handoverInput();
    data.plans.push({ ...plan, rootThreadId: oldHead });
    const snapshot = aggregate(data);
    expect(snapshot.projects.some((p) => p.rootThreadId === oldHead)).toBe(true);
    expect(snapshot.planMigration?.some((w) => /tracker briefing file/i.test(w.reason))).toBe(true);
  });
  it("resolves a chain through a historical header and guards cycles", () => {
    const data = handoverInput(true);
    const ancestor = ThreadId.make("ancestor");
    data.plans.push({
      ...plan,
      rootThreadId: oldHead,
      predecessorRootThreadIds: [ancestor],
    } as BriefingPlan);
    data.issues = new Map(
      [t3Head, nextHead, dashHead].map((id) => [
        id,
        [makeIssue(99, { linkedThreadIds: [ancestor] })],
      ]),
    );
    expect(
      aggregate(data).projects.find((p) => p.tasks.some((t) => t.title === "Issue 99"))
        ?.rootThreadId,
    ).toBe(nextHead);
    data.plans = [
      { ...plan, rootThreadId: nextHead },
      { ...plan, rootThreadId: ancestor, predecessorRootThreadIds: [oldHead] },
      { ...plan, rootThreadId: oldHead, predecessorRootThreadIds: [ancestor] },
    ];
    const cycle = aggregate(data);
    expect(cycle.planMigration?.some((w) => /cycle/.test(w.reason))).toBe(true);
    expect(cycle.projects.some((p) => p.rootThreadId === nextHead)).toBe(true);
  });
});

it.each([false, true])(
  "keeps links and repositories discovered only by the predecessor (settled=%s)",
  (settled) => {
    const data = handoverInput(settled);
    const source = { threadId: t3Head, rootThreadId: t3Head, messageId: "m" };
    const common = makeIssue(80, { requestSource: source });
    const adopted = { ...common, linkedThreadIds: [oldHead] };
    const foreign = makeIssue(81, {
      repository: "brad/predecessor-only",
      url: "https://git.test/brad/predecessor-only/issues/81",
      linkedThreadIds: [oldHead],
      requestSource: source,
    });
    data.issues = new Map([
      [t3Head, [common]],
      [nextHead, [common]],
      [dashHead, []],
      [oldHead, [adopted, foreign]],
    ]);
    const snapshot = aggregate(data);
    const project = snapshot.projects.find((p) => p.rootThreadId === nextHead);
    expect(project?.tasks.map((t) => t.title).sort()).toEqual(["Issue 80", "Issue 81"]);
    expect(snapshot.projects.find((p) => p.rootThreadId === t3Head)?.tasks).toHaveLength(0);
    expect(snapshot.projects.some((p) => p.rootThreadId === oldHead)).toBe(false);
    const keys = snapshot.projects.flatMap((p) => p.tasks.map((t) => t.id));
    expect(new Set(keys).size).toBe(keys.length);
  },
);

describe("threads working on a Plan row (#364)", () => {
  const startedAt = DateTime.makeUnsafe("2026-10-14T09:48:00.000Z");
  const shellOf = (id: ThreadId, extra: Record<string, unknown> = {}) => ({
    ...v2ThreadShell,
    id,
    title: `Thread ${id}`,
    archivedAt: null,
    todoProgress: null,
    status: "idle" as const,
    activityRunStartedAt: null,
    ...extra,
  });
  const running = (id: ThreadId, extra: Record<string, unknown> = {}) =>
    shellOf(id, { status: "running", activityRunStartedAt: startedAt, ...extra });
  const scenario = (
    workers: readonly ReturnType<typeof shellOf>[],
    issues: ProjectIssue[],
    headStatus: "running" | "idle" = "running",
  ) => ({
    ...input(issues),
    shells: [
      shellOf(root, { title: "Head", status: headStatus, activityRunStartedAt: startedAt }),
      ...workers,
    ],
    metadata: [
      { threadId: root, parentThreadId: null, subproject: "on" as const },
      ...workers.map((w) => ({ threadId: w.id, parentThreadId: root })),
    ],
  });
  const workersOf = (data: ReturnType<typeof scenario>, number = 1) =>
    aggregate(data).projects[0]?.tasks.find((t) => t.title === `Issue ${number}`)?.workers;
  const w1 = ThreadId.make("w1");
  const w2 = ThreadId.make("w2");
  const w3 = ThreadId.make("w3");

  it("shows an explicitly linked running thread and never the owning head", () => {
    const data = scenario([running(w1)], [makeIssue(1, { linkedThreadIds: [root, w1] })]);
    expect(workersOf(data)).toEqual([
      {
        threadId: w1,
        title: "Thread w1",
        state: "running",
        startedAt: "2026-10-14T09:48:00.000Z",
      },
    ]);
  });
  it("shows starting and queued work as such, and nothing for waiting, held, idle or finished", () => {
    const hidden = [
      shellOf(ThreadId.make("waiting"), { status: "waiting" }),
      shellOf(ThreadId.make("held"), { status: "queued", queueHeld: true }),
      shellOf(ThreadId.make("idle")),
      shellOf(ThreadId.make("done"), { status: "completed" }),
      running(ThreadId.make("settled"), { settledOverride: "settled" }),
      running(ThreadId.make("archived"), { archivedAt: DateTime.makeUnsafe(now) }),
    ];
    const data = scenario(
      [shellOf(w1, { status: "queued" }), shellOf(w2, { status: "preparing" }), ...hidden],
      [makeIssue(1, { linkedThreadIds: [w1, w2, ...hidden.map((h) => h.id)] })],
    );
    expect(workersOf(data)?.map((w) => [w.threadId, w.state, w.startedAt])).toEqual([
      [w2, "starting", null],
      [w1, "queued", null],
    ]);
  });
  it("shows a thread the moment it is linked, before the cached issue rows learn of it", () => {
    const link = {
      host: "git.test",
      repository: "brad/repo",
      number: 1,
      url: "https://git.test/brad/repo/issues/1",
      linkedAt: now,
      snapshot: { title: "Issue 1", state: "open" as const, syncedAt: now },
    };
    const data = scenario(
      [running(w1, { issues: [link] }), running(w2, { issues: [{ ...link, number: 2 }] })],
      [makeIssue(1, { linkedThreadIds: [] })],
    );
    expect(workersOf(data)?.map((w) => w.threadId)).toEqual([w1]);
  });
  it("hides a child whose parent, not the child, holds the link", () => {
    const data = scenario([running(w1)], [makeIssue(1, { linkedThreadIds: [root] })]);
    expect(workersOf(data)).toBeUndefined();
    expect(aggregate(data).projects[0]?.tasks[0]).not.toHaveProperty("workers");
  });
  // Product's head P owns the item; the T3 head T is a narrower sub-root of P, so on a linked tie T wins.
  describe("with two heads", () => {
    const P = ThreadId.make("product-head");
    const T = ThreadId.make("t3-head");
    const C = ThreadId.make("t3-child");
    const Q = ThreadId.make("product-child");
    const link = {
      host: "git.test",
      repository: "brad/repo",
      number: 1,
      url: "https://git.test/brad/repo/issues/1",
      linkedAt: now,
      snapshot: { title: "Issue 1", state: "open" as const, syncedAt: now },
    };
    const twoHeads = (childIssues: ReadonlyArray<unknown>, linkedThreadIds: ThreadId[]) => {
      const issue = makeIssue(1, {
        linkedThreadIds,
        requestSource: { threadId: P, rootThreadId: P, messageId: "m" },
      });
      return {
        ...input([issue]),
        shells: [
          running(P, { title: "Product" }),
          running(T, { title: "T3" }),
          running(C, { issues: childIssues }),
          shellOf(Q),
        ],
        metadata: [
          { threadId: P, parentThreadId: null, subproject: "on" as const },
          { threadId: T, parentThreadId: P, subproject: "on" as const },
          { threadId: C, parentThreadId: T },
          { threadId: Q, parentThreadId: P },
        ],
        issues: new Map([
          [P, [issue]],
          [T, [issue]],
        ]),
      };
    };
    const place = (data: ReturnType<typeof twoHeads>) => {
      const snapshot = aggregate(data);
      const project = snapshot.projects.find((p) => p.tasks.some((t) => t.title === "Issue 1"));
      return { owner: project?.rootThreadId, workers: project?.tasks[0]?.workers };
    };
    it("keeps the item on Product's Plan when the T3 head delegates a child with that issue", () => {
      const delegated = { ...link, role: "worker" as const };
      const { owner, workers } = place(twoHeads([delegated], [C]));
      expect(owner).toBe(P);
      expect(workers?.map((w) => w.threadId)).toEqual([C]);
    });
    it("still lets a thread's ordinary link decide ownership, as before", () => {
      expect(place(twoHeads([link], [C])).owner).toBe(T);
      // Links stored before children stopped inheriting keep deciding as they did; a new child
      // without one leaves the item with the head that holds it.
      expect(place(twoHeads([link], [P, C])).owner).toBe(T);
      expect(place(twoHeads([], [P])).owner).toBe(P);
    });
  });
  it("hides a worker the moment its own links drop the item, before the cached rows catch up", () => {
    const link = {
      host: "git.test",
      repository: "brad/repo",
      number: 1,
      url: "https://git.test/brad/repo/issues/1",
      linkedAt: now,
      snapshot: { title: "Issue 1", state: "open" as const, syncedAt: now },
    };
    const stale = makeIssue(1, { linkedThreadIds: [w1] });
    expect(workersOf(scenario([running(w1, { issues: [link] })], [stale]))).toHaveLength(1);
    // Unlinked: the shell says so, the cached row still names the thread.
    expect(workersOf(scenario([running(w1, { issues: [] })], [stale]))).toBeUndefined();
    // A server that predates shell links says nothing, so the cached row still decides.
    expect(workersOf(scenario([running(w1)], [stale]))).toHaveLength(1);
  });
  it("lists the longest-running first, deduplicates, and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      running(ThreadId.make(`m${String(i).padStart(2, "0")}`), {
        activityRunStartedAt: DateTime.makeUnsafe(
          `2026-10-14T09:${String(59 - i).padStart(2, "0")}:00.000Z`,
        ),
      }),
    );
    const data = scenario(many, [
      makeIssue(1, { linkedThreadIds: [...many.map((w) => w.id), many[0]!.id] }),
    ]);
    const workers = workersOf(data)!;
    expect(aggregate(data).projects[0]?.tasks[0]?.workerCount).toBe(12);
    expect(workers).toHaveLength(8);
    expect(workers[0]?.threadId).toBe("m11");
    expect(new Set(workers.map((w) => w.threadId)).size).toBe(8);
  });
  it("puts a workstream's own workers on its heading", () => {
    const epic = makeIssue(5, {
      epic: { done: 1, total: 4, remaining: [6] },
      plan: { ...summary, done: 1, total: 4 },
      linkedThreadIds: [w1],
    });
    const snapshot = aggregate(scenario([running(w1)], [epic, makeIssue(6, { partOf: 5 })]));
    const workstream = snapshot.projects[0]?.workstreams.find((w) => w.title === "Issue 5");
    expect(workstream?.workers?.map((w) => w.threadId)).toEqual([w1]);
  });
  it("does not count a predecessor head as a worker, but keeps a real worker", () => {
    const data = handoverInput();
    const workerShell = (id: ThreadId) => data.shells.find((s) => s.id === id)!;
    Object.assign(workerShell(oldHead), { status: "running" });
    Object.assign(workerShell(worker), { status: "running", activityRunStartedAt: startedAt });
    data.issues = new Map(
      [t3Head, oldHead, nextHead, dashHead, worker].map((id) => [
        id,
        [makeIssue(3, { linkedThreadIds: [oldHead, worker] })],
      ]),
    );
    const task = aggregate(data)
      .projects.flatMap((p) => p.tasks)
      .find((t) => t.title === "Issue 3");
    expect(task?.workers?.map((w) => w.threadId)).toEqual([worker]);
  });
  it("keeps a row being worked ahead of an idle one when the snapshot is over budget", () => {
    const snapshot = aggregate(
      scenario([running(w1)], [makeIssue(1), makeIssue(2, { linkedThreadIds: [w1] })]),
    );
    expect(snapshot.projects[0]?.tasks.map((t) => t.title)).toContain("Issue 1");
    // Shrink the budget until exactly one row fits.
    let kept: string[] = [];
    for (let budget = 20_000; budget > 0 && kept.length !== 1; budget -= 25)
      kept = compactSnapshot(snapshot, budget).projects[0]!.tasks.map((t) => t.title);
    expect(kept).toEqual(["Issue 2"]);
  });
  it("survives the wire schema and compaction", () => {
    const snapshot = aggregate(
      scenario(
        [running(w1), running(w2), running(w3)],
        [makeIssue(1, { linkedThreadIds: [w1, w2, w3] })],
      ),
    );
    const wire = decodeSnapshot(JSON.parse(JSON.stringify(compactSnapshot(snapshot))));
    expect(wire.projects[0]?.tasks[0]?.workers).toHaveLength(3);
  });
});
