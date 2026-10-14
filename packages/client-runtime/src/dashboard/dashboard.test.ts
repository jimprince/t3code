import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ThreadId,
  type ProjectIssue,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { aggregate, dashboardRoots } from "./aggregation.ts";
import { composeOlderDashboard } from "./fallback.ts";
import { compactSnapshot, emptySnapshot, sampleProgress } from "./progress.ts";
import {
  compareDashboardVersions,
  createDashboardSnapshotMerger,
  filePlanKey,
  mergeDashboardSnapshots,
  overlayAnswered,
} from "./merge.ts";
const now = "2026-10-11T10:00:00.000Z";
const root = ThreadId.make("a-root");
const other = ThreadId.make("b-root");
const child = ThreadId.make("child");
const issue: ProjectIssue = {
  host: "git.test",
  repository: "brad/repo",
  number: 1,
  title: "Choose",
  url: "https://git.test/brad/repo/issues/1",
  status: "pending",
  labels: ["needs-brad"],
  isRequest: false,
  requestSource: null,
  assignees: [],
  comments: 0,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
  linkedThreadIds: [child],
  decision: { context: "Which?", waiting: "head", options: [{ text: "Yes", recommended: true }] },
};
const shell: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [],
  archivedThreads: [],
  threads: [root, other, child].map((id) => ({
    ...v2ThreadShell,
    id,
    archivedAt: null,
    updatedAt: DateTime.makeUnsafe(now),
    status: "running" as const,
    todoProgress: { completed: 2, total: 4 },
  })),
};
const metadata = [
  { threadId: root, parentThreadId: null, subproject: "on" as const },
  { threadId: other, parentThreadId: null, subproject: "on" as const },
  { threadId: child, parentThreadId: other },
];
const input = {
  shell,
  metadata,
  issues: new Map([
    [root, [issue]],
    [other, [issue]],
  ]),
  asks: [],
  roadmaps: new Map(),
  sources: [],
  now,
  revision: 1,
};

describe("older-server dashboard", () => {
  it("maps real steps and decisions with unknown movement, using the linked project's ownership", () => {
    const snapshot = composeOlderDashboard(input);
    const tasks = snapshot.projects.flatMap((p) => p.tasks).filter((t) => t.url === issue.url);
    expect(tasks).toHaveLength(1);
    expect(snapshot.projects.find((p) => p.rootThreadId === other)?.tasks).toContainEqual(
      expect.objectContaining({ url: issue.url }),
    );
    expect(tasks[0]?.progress).toMatchObject({ done: 2, total: 4 });
    expect(tasks[0]?.movement.state).toBe("unknown");
    expect(snapshot.projects.flatMap((p) => p.attention)).toHaveLength(1);
  });
  it("keeps a head with only remote workers and routes a cross-project decision to its waiting thread", () => {
    const remote = ThreadId.make("a6aac268-fd81-462c-ab1d-4b2d92609ba0");
    const scenario = {
      ...input,
      shell: {
        ...shell,
        threads: shell.threads.map((t) => (t.id === root ? { ...t, id: remote } : t)),
      },
      metadata: metadata.map((row) =>
        row.threadId === root ? { threadId: remote, parentThreadId: null } : row,
      ),
      remoteParentThreadIds: [remote],
      issues: new Map([
        [
          other,
          [
            {
              ...issue,
              linkedThreadIds: [],
              decision: { ...issue.decision!, waiting: "clinic-scheduler-orchestrator (a6aac268)" },
              owner: { threadId: other, title: "Other", projectTitle: "VM" },
            },
          ],
        ],
      ]),
      ownRepositories: new Map([[other, "git.test/brad/repo"]]),
    };
    const snapshot = composeOlderDashboard(scenario);
    expect(snapshot.projects.find((p) => p.rootThreadId === remote)?.attention).toHaveLength(1);
    expect(snapshot.projects.find((p) => p.rootThreadId === other)?.attention).toHaveLength(0);
    expect(snapshot.projects.find((p) => p.rootThreadId === remote)?.tasks[0]?.threadId).toBe(
      remote,
    );
    const ambiguous = composeOlderDashboard({
      ...scenario,
      shell: {
        ...scenario.shell,
        threads: [
          ...scenario.shell.threads,
          {
            ...scenario.shell.threads[0]!,
            id: ThreadId.make("a6aac268-1111-1111-1111-111111111111"),
          },
        ],
      },
    });
    expect(ambiguous.projects.find((p) => p.rootThreadId === remote)?.attention).toHaveLength(0);
    expect(composeOlderDashboard({ ...input, metadata: [] }).projects).toHaveLength(0);
  });

  it("attributes a duplicated tracker decision to its owning host regardless of host order", () => {
    const snapshot = composeOlderDashboard(input);
    const project = snapshot.projects.find((p) => p.attention.length)!;
    const attention = { ...project.attention[0]!, threadId: root };
    const mac = {
      ...snapshot,
      projects: [
        {
          ...project,
          rootThreadId: other,
          attention: [attention],
          tasks: project.tasks.map((task) => ({ ...task, threadId: null })),
        },
      ],
    };
    const vm = {
      ...snapshot,
      projects: [
        {
          ...project,
          rootThreadId: root,
          attention: [attention],
          tasks: project.tasks.map((task) => ({ ...task, threadId: root })),
        },
      ],
    };
    const parts = [
      { environmentId: EnvironmentId.make("mac"), snapshot: mac },
      { environmentId: EnvironmentId.make("vm"), snapshot: vm },
    ];
    for (const entries of [parts, parts.toReversed()]) {
      const decisions = mergeDashboardSnapshots(entries).projects.filter(
        (p) => p.project.attention.length,
      );
      expect(decisions.map((p) => p.environmentId)).toEqual(["vm"]);
      expect(decisions[0]?.project.attention[0]?.sourceId).toBe("vm:gitea:git.test/brad/repo");
    }
  });

  it("assigns unlinked repository work to its own root before a cross-repository root", () => {
    const snapshot = aggregate({
      ...input,
      shells: shell.threads,
      plans: [],
      samples: [],
      issues: new Map([
        [root, [{ ...issue, linkedThreadIds: [] }]],
        [other, [{ ...issue, linkedThreadIds: [] }]],
      ]),
      rootRepositories: new Map([[other, "git.test/brad/repo"]]),
    });
    expect(
      snapshot.projects
        .find((p) => p.rootThreadId === other)
        ?.tasks.some((t) => t.url === issue.url),
    ).toBe(true);
    expect(
      snapshot.projects
        .find((p) => p.rootThreadId === root)
        ?.tasks.some((t) => t.url === issue.url),
    ).toBe(false);
  });
  it("uses roadmap versions as finite workstreams without making milestone counts into steps", () => {
    const roadmap = {
      tracker: { host: issue.host, repository: issue.repository },
      versions: [{ id: 2, title: "Next release", dueOn: null, openIssues: 1, closedIssues: 0 }],
      items: [
        {
          number: 1,
          title: issue.title,
          url: issue.url,
          isRequest: false,
          stage: null,
          versionId: 2,
          parked: false,
        },
      ],
    };
    const snapshot = composeOlderDashboard({ ...input, roadmaps: new Map([[other, roadmap]]) });
    expect(
      snapshot.projects
        .find((p) => p.rootThreadId === other)
        ?.workstreams.some((w) => w.title === "Next release"),
    ).toBe(true);
  });
  it("federates every host, dedupes decisions and preserves each host's source age", () => {
    const snapshot = composeOlderDashboard(input);
    const sources = [
      {
        id: "local",
        kind: "local" as const,
        observedAt: now,
        lastSuccessAt: now,
        staleAfterMs: 60000,
        coverage: "complete" as const,
        failed: false,
      },
    ];
    const data = mergeDashboardSnapshots([
      { environmentId: EnvironmentId.make("one"), snapshot: { ...snapshot, sources } },
      {
        environmentId: EnvironmentId.make("two"),
        snapshot: {
          ...snapshot,
          sources: [{ ...sources[0]!, lastSuccessAt: "2026-10-10T10:00:00Z" }],
        },
      },
    ]);
    expect(data.projects).toHaveLength(4);
    expect(data.projects.flatMap((p) => p.project.attention)).toHaveLength(1);
    expect(data.sources.map((s) => s.id)).toEqual(["one:local", "two:local"]);
    expect(data.sources[1]?.lastSuccessAt).toBe("2026-10-10T10:00:00Z");
    expect(data.projects[2]?.project.tasks[0]?.progress?.sourceId).toBe("two:local");
  });
  it("does not let earlier projects consume every row under the size cap", () => {
    const snapshot = composeOlderDashboard(input);
    const task = snapshot.projects.flatMap((p) => p.tasks)[0]!;
    const projects = [root, other, child].map((id) => ({
      ...snapshot.projects[0]!,
      id,
      tasks: Array.from({ length: 100 }, (_, n) => ({
        ...task,
        id: `${id}:${n}`,
        title: "Work".repeat(50),
      })),
    }));
    const compact = compactSnapshot({ ...snapshot, projects }, 16000);
    expect(compact.projects.every((p) => p.tasks.length > 0)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(compact)).length).toBeLessThan(16000);
  });
  it("hides sent answers past six seconds, retains unrelated cards and bounds the overlay", () => {
    const snapshot = composeOlderDashboard(input);
    const attention = snapshot.projects.flatMap((p) => p.attention)[0]!;
    const answered = new Map([[attention.id, Date.parse(now)]]);
    expect(
      overlayAnswered(snapshot, answered, Date.parse(now) + 7000).projects.flatMap(
        (p) => p.attention,
      ),
    ).toHaveLength(0);
    expect(
      overlayAnswered(
        snapshot,
        new Map([["unrelated", Date.parse(now)]]),
        Date.parse(now) + 7000,
      ).projects.flatMap((p) => p.attention),
    ).toHaveLength(1);
    expect(
      overlayAnswered(snapshot, answered, Date.parse(now) + 300001).projects.flatMap(
        (p) => p.attention,
      ),
    ).toHaveLength(1);
  });
  it("reuses unchanged merges and refreshes when an environment or snapshot changes", () => {
    const merge = createDashboardSnapshotMerger();
    const snapshot = composeOlderDashboard(input);
    const environmentId = EnvironmentId.make("one");
    const first = merge([{ environmentId, snapshot }]);
    expect(merge([{ environmentId, snapshot }])).toBe(first);
    const updated = {
      ...snapshot,
      projects: snapshot.projects.map((p) => ({ ...p, title: "Updated" })),
    };
    const refreshed = merge([{ environmentId, snapshot: updated }]);
    expect(refreshed).not.toBe(first);
    expect(refreshed.projects[0]?.project.title).toBe("Updated");
    const moved = merge([{ environmentId: EnvironmentId.make("two"), snapshot: updated }]);
    expect(moved.projects[0]?.environmentId).toBe("two");
    expect(merge([]).projects).toEqual([]);
  });
  it("keeps the snapshot's identity when no answer touches it", () => {
    const snapshot = composeOlderDashboard(input);
    expect(overlayAnswered(snapshot, new Map(), Date.parse(now))).toBe(snapshot);
    expect(
      overlayAnswered(snapshot, new Map([["unrelated", Date.parse(now)]]), Date.parse(now)),
    ).toBe(snapshot);
  });
  it("orders v-prefixed nightly and fork versions numerically", () => {
    expect(
      compareDashboardVersions(
        "0.0.46-nightly.20261005.2689-fork.12",
        "v0.0.46-nightly.20261005.2689-fork.11",
      ),
    ).toBe(1);
    expect(compareDashboardVersions("v0.0.46-fork.9", "0.0.46-fork.10")).toBe(-1);
    expect(compareDashboardVersions("0.0.46-fork.12", "v0.0.46-fork.12")).toBe(0);
  });
  it("samples duplicate task ids once and drops completed older release rows", () => {
    const snapshot = composeOlderDashboard(input);
    const task = snapshot.projects.flatMap((p) => p.tasks).find((t) => t.progress)!;
    expect(sampleProgress([task, task], [], now)).toHaveLength(1);
    const release = aggregate({
      shells: shell.threads,
      metadata,
      issues: new Map(),
      sources: [],
      samples: [],
      now,
      plans: [
        {
          head: "t3",
          rootThreadId: root,
          title: "T3",
          updated_utc: now,
          workstreams: [
            {
              id: "release",
              title: "Release",
              tasks: [
                {
                  id: "old",
                  title: "Old release",
                  kind: "release",
                  link: "",
                  steps_done: 2,
                  steps_total: 2,
                  eta_utc: null,
                  next_step: "",
                  updated_utc: "2026-10-09T10:00:00Z",
                },
                {
                  id: "new",
                  title: "Fresh finish",
                  kind: "release",
                  link: "",
                  steps_done: 2,
                  steps_total: 2,
                  eta_utc: null,
                  next_step: "",
                  updated_utc: now,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(release.releases.map((r) => r.title)).toEqual(["Fresh finish"]);
    expect(
      release.projects.flatMap((p) => p.tasks).find((t) => t.title === "Fresh finish")?.closedAt,
    ).toBe(now);
  });
  it("leaves a first-ever empty snapshot truthful", () =>
    expect(
      mergeDashboardSnapshots([{ environmentId: EnvironmentId.make("one"), snapshot: null }]).asOf,
    ).toBeNull());
});

describe("successful dashboard answers", () => {
  it("keeps acknowledged old-server answers hidden across a stale snapshot and navigation", async () => {
    const { dashboardAnswer, overlayDashboardAnswers } = await import("./answers.ts");
    const snapshot = composeOlderDashboard(input);
    const env = EnvironmentId.make("one");
    const answer = dashboardAnswer(
      env,
      { threadId: other, reference: "brad/repo#1", decision: "option", option: "Yes" },
      Date.parse(now),
    );
    expect(
      overlayDashboardAnswers(snapshot, env, [answer], Date.parse(now) + 7000).projects.flatMap(
        (p) => p.attention,
      ),
    ).toHaveLength(0);
    expect(
      overlayDashboardAnswers(
        snapshot,
        EnvironmentId.make("two"),
        [answer],
        Date.parse(now) + 7000,
      ).projects.flatMap((p) => p.attention),
    ).toHaveLength(1);
    expect(
      overlayDashboardAnswers(
        snapshot,
        env,
        [{ ...answer, reference: "other/repo#1" }],
        Date.parse(now) + 7000,
      ).projects.flatMap((p) => p.attention),
    ).toHaveLength(1);
  });
});

describe("answer source confirmation", () => {
  it("requires a later complete and healthy snapshot before releasing suppression", async () => {
    const { dashboardAnswer, dashboardAnswerConfirmed } = await import("./answers.ts");
    const snapshot = composeOlderDashboard(input);
    const answer = dashboardAnswer(
      EnvironmentId.make("one"),
      { threadId: other, reference: "brad/repo#1", decision: "option" },
      Date.parse(now),
    );
    const sources = [...new Set(snapshot.projects.flatMap((p) => p.sourceIds))].map((id) => ({
      id,
      kind: "local" as const,
      observedAt: now,
      lastSuccessAt: now,
      staleAfterMs: 60000,
      coverage: "complete" as const,
      failed: false,
    }));
    const removed = {
      ...snapshot,
      sources,
      projects: snapshot.projects.map((p) => ({ ...p, attention: [] })),
    };
    expect(dashboardAnswerConfirmed({ ...snapshot, sources }, answer)).toBe(false);
    expect(dashboardAnswerConfirmed(removed, answer)).toBe(true);
    expect(dashboardAnswerConfirmed({ ...removed, asOf: "2026-10-11T09:59:00Z" }, answer)).toBe(
      false,
    );
    expect(
      dashboardAnswerConfirmed(
        { ...removed, projects: removed.projects.map((p) => ({ ...p, omittedTaskCount: 1 })) },
        answer,
      ),
    ).toBe(false);
    expect(
      dashboardAnswerConfirmed(
        { ...removed, sources: sources.map((s) => ({ ...s, failed: true })) },
        answer,
      ),
    ).toBe(false);
  });
});

describe("answers duplicated on connected hosts", () => {
  it("suppresses the same decision on another host when the first host acknowledges it", async () => {
    const { registerDashboardDecisions, dashboardAnswer, overlayDashboardAnswers } =
      await import("./answers.ts");
    const snapshot = composeOlderDashboard(input);
    const first = EnvironmentId.make("first-copy");
    const second = EnvironmentId.make("second-copy");
    registerDashboardDecisions(first, snapshot);
    const answer = dashboardAnswer(
      first,
      { threadId: other, reference: "brad/repo#1", decision: "option" },
      Date.parse(now),
    );
    expect(answer.attentionId).toBe(snapshot.projects.flatMap((p) => p.attention)[0]?.id);
    expect(
      overlayDashboardAnswers(snapshot, second, [answer], Date.parse(now) + 7000).projects.flatMap(
        (p) => p.attention,
      ),
    ).toHaveLength(0);
    expect(
      overlayDashboardAnswers(
        snapshot,
        second,
        [{ ...answer, attentionId: "issue:other.test/brad/repo#1:attention" }],
        Date.parse(now) + 7000,
      ).projects.flatMap((p) => p.attention),
    ).toHaveLength(1);
  });
});

describe("retired dashboard heads", () => {
  it("removes archived descendants and their linked decisions from an active head", () => {
    const archived = {
      ...shell.threads.find((t) => t.id === child)!,
      archivedAt: DateTime.makeUnsafe(now),
    };
    const snapshot = composeOlderDashboard({
      ...input,
      shell: {
        ...shell,
        threads: shell.threads.filter((t) => t.id !== child),
        archivedThreads: [archived],
      },
    });
    expect(snapshot.projects.map((p) => p.rootThreadId)).toEqual([root, other]);
    expect(snapshot.projects.flatMap((p) => p.tasks).some((t) => t.threadId === child)).toBe(false);
    expect(snapshot.projects.flatMap((p) => p.attention)).toEqual([]);
  });

  it.each([
    { title: "Operations (retired 2026-10-10)" },
    { title: "Deployment (RETIRED)" },
    { archivedAt: DateTime.makeUnsafe(now) },
    { settledOverride: "settled" as const },
  ])("excludes inactive roots and their tasks, decisions and omitted counts: %j", (inactive) => {
    const scenario = {
      ...input,
      shell: {
        ...shell,
        threads: shell.threads.map((t) => (t.id === other ? { ...t, ...inactive } : t)),
      },
      issues: new Map([
        [root, [{ ...issue, number: 999, linkedThreadIds: [root] }]],
        [other, Array.from({ length: 220 }, (_, i) => ({ ...issue, number: i + 1 }))],
      ]),
    };
    const baseline = composeOlderDashboard({ ...scenario, shell });
    expect(baseline.projects.some((p) => p.omittedTaskCount > 0)).toBe(true);
    const snapshot = composeOlderDashboard(scenario);
    expect(snapshot.projects.map((p) => p.rootThreadId)).toEqual([root]);
    expect(snapshot.projects[0]?.tasks.map((t) => t.url)).toEqual([issue.url]);
    expect(snapshot.projects.flatMap((p) => p.attention).map((a) => a.taskId)).toEqual([
      "issue:git.test/brad/repo#999",
    ]);
    expect(snapshot.projects.reduce((n, p) => n + p.omittedTaskCount, 0)).toBe(0);
    expect(dashboardRoots(scenario.shell.threads, metadata).threads.map((t) => t.id)).toEqual([
      root,
    ]);
    // The server re-exports this same aggregation path.
    const serverSnapshot = aggregate({
      shells: scenario.shell.threads,
      metadata,
      issues: scenario.issues,
      sources: [],
      plans: [],
      samples: [],
      now,
    });
    expect(serverSnapshot.projects.map((p) => p.rootThreadId)).toEqual([root]);
    expect(serverSnapshot.projects.flatMap((p) => p.attention)).toHaveLength(1);
  });

  it("does not reassign a retired head's shared-repository decision to an active head", () => {
    const snapshot = composeOlderDashboard({
      ...input,
      shell: {
        ...shell,
        threads: shell.threads.map((t) =>
          t.id === other ? { ...t, settledOverride: "settled" as const } : t,
        ),
      },
    });
    expect(snapshot.projects.map((p) => p.rootThreadId)).toEqual([root]);
    expect(snapshot.projects[0]?.tasks).toHaveLength(1);
    expect(snapshot.projects[0]?.tasks[0]?.id).toBe(`thread-plan:${root}`);
    expect(snapshot.projects.flatMap((p) => p.attention)).toEqual([]);
  });

  it("keeps active overrides and titles mentioning retirement without the marker", () => {
    const threads = shell.threads.map((t) => ({
      ...t,
      title: "Retired equipment cleanup",
      settledOverride: "active" as const,
      settledAt: DateTime.makeUnsafe(now),
    }));
    expect(dashboardRoots(threads, metadata).roots.map((t) => t.id)).toEqual([root, other]);
  });
});

it("fills issue and thread-plan next steps while preserving a supplied briefing next_step", () => {
  const shells = shell.threads.map((thread) => ({
    ...thread,
    todoProgress: {
      completed: 1,
      total: 3,
      currentStep: { id: "verify", text: "Verify stored changes", status: "running" as const },
    },
  }));
  const base = { shells, metadata, issues: input.issues, sources: [], plans: [], samples: [], now };
  const result = aggregate(base);
  const tasks = result.projects.flatMap((project) => project.tasks);
  expect(tasks.find((task) => task.url === issue.url)?.nextStep).toBe("Verify stored changes");
  expect(tasks.find((task) => task.id === `thread-plan:${root}`)?.nextStep).toBe(
    "Verify stored changes",
  );
  const enriched = aggregate({
    ...base,
    plans: [
      {
        head: "head",
        rootThreadId: root,
        title: "Plan",
        updated_utc: now,
        workstreams: [
          {
            id: "work",
            title: "Work",
            tasks: [
              {
                id: "issue",
                title: "Choose",
                kind: "issue",
                link: issue.url,
                steps_total: 3,
                steps_done: 1,
                eta_utc: null,
                next_step: "Owner's next step",
                updated_utc: now,
              },
            ],
          },
        ],
      },
    ],
  });
  expect(
    enriched.projects.flatMap((project) => project.tasks).find((task) => task.url === issue.url)
      ?.nextStep,
  ).toBe("Owner's next step");
});

describe("thread-plan rows", () => {
  const planned = (
    overrides: Partial<(typeof shell.threads)[number]> & { readonly id?: ThreadId },
  ) => ({ ...shell.threads[0]!, ...overrides });
  const stopped = {
    latestRunStatus: "failed" as const,
    hasLiveSession: false,
    hasLiveTurn: false,
    failedSession: true,
  };
  const rows = (threads: ReadonlyArray<ReturnType<typeof planned>>) =>
    aggregate({
      shells: threads,
      metadata: [{ threadId: root, parentThreadId: null, subproject: "on" as const }],
      issues: new Map(),
      sources: [],
      plans: [],
      samples: [],
      now,
    }).projects.flatMap((project) => project.tasks);
  const progress = {
    completed: 2,
    total: 5,
    currentStep: { id: "s3", text: "Wire the store", status: "running" as const },
  };

  it("shows a running thread's steps and current step", () => {
    const [task] = rows([planned({ id: root, status: "running", todoProgress: progress })]);
    expect(task).toMatchObject({
      id: `thread-plan:${root}`,
      status: "working",
      progress: { done: 2, total: 5 },
      nextStep: "Wire the store",
    });
  });

  it("keeps a thread that is waiting on someone", () => {
    expect(
      rows([planned({ id: root, status: "waiting", todoProgress: progress })]).map((t) => t.id),
    ).toEqual([`thread-plan:${root}`]);
  });

  it("shows no row for a thread without a plan", () => {
    expect(rows([planned({ id: root, status: "running", todoProgress: null })])).toEqual([]);
  });

  it("shows a stopped thread with steps left, frozen at its last step", () => {
    const [task] = rows([
      planned({ id: root, status: "failed", todoProgress: progress, planResumeState: stopped }),
    ]);
    expect(task).toMatchObject({
      status: "blocked",
      progress: { done: 2, total: 5 },
      nextStep: "Wire the store",
      movement: { state: "unknown", doneDelta: null },
    });
  });

  it("drops a thread that went idle without failing, and a finished plan", () => {
    expect(
      rows([
        planned({
          id: root,
          status: "idle",
          todoProgress: progress,
          planResumeState: { ...stopped, latestRunStatus: "completed", failedSession: false },
        }),
      ]),
    ).toEqual([]);
    expect(
      rows([
        planned({
          id: root,
          status: "running",
          todoProgress: { completed: 5, total: 5, currentStep: null },
        }),
        planned({
          id: child,
          status: "failed",
          todoProgress: { completed: 5, total: 5, currentStep: null },
          planResumeState: stopped,
        }),
      ]),
    ).toEqual([]);
  });

  it("keeps a stopped issue-linked thread on its issue row, with no second plan row", () => {
    const tasks = aggregate({
      shells: [
        planned({ id: root, status: "running", todoProgress: null }),
        planned({ id: child, status: "failed", todoProgress: progress, planResumeState: stopped }),
      ],
      metadata: [
        { threadId: root, parentThreadId: null, subproject: "on" as const },
        { threadId: child, parentThreadId: root },
      ],
      issues: new Map([[root, [{ ...issue, linkedThreadIds: [child] }]]]),
      sources: [],
      plans: [],
      samples: [],
      now,
    }).projects.flatMap((project) => project.tasks);
    expect(tasks.map((task) => task.id)).not.toContain(`thread-plan:${child}`);
    expect(tasks.find((task) => task.url === issue.url)).toMatchObject({ threadId: child });
  });

  it("keeps a stopped linked thread that the issue row does not pick as its own plan row", () => {
    const sibling = ThreadId.make("sibling");
    const tasks = aggregate({
      shells: [
        planned({ id: root, status: "running", todoProgress: null }),
        // The issue row resolves to the first linked thread with a plan: the live head's child.
        planned({ id: child, status: "running", todoProgress: progress }),
        planned({
          id: sibling,
          status: "failed",
          todoProgress: progress,
          planResumeState: stopped,
        }),
      ],
      metadata: [
        { threadId: root, parentThreadId: null, subproject: "on" as const },
        { threadId: child, parentThreadId: root },
        { threadId: sibling, parentThreadId: root },
      ],
      issues: new Map([[root, [{ ...issue, linkedThreadIds: [child, sibling] }]]]),
      sources: [],
      plans: [],
      samples: [],
      now,
    }).projects.flatMap((project) => project.tasks);
    expect(tasks.find((task) => task.url === issue.url)).toMatchObject({ threadId: child });
    expect(tasks.map((task) => task.id)).not.toContain(`thread-plan:${child}`);
    expect(tasks.find((task) => task.id === `thread-plan:${sibling}`)).toMatchObject({
      status: "blocked",
      threadId: sibling,
    });
  });

  describe("an issue that waits on one thread but borrows another's steps", () => {
    // The issue names the head as waiting, so its row points at the head, but its progress and next
    // step come from the linked worker: the worker's steps are already on the issue row.
    const worker = ThreadId.make("borrowed-worker");
    const waitingIssue = {
      ...issue,
      linkedThreadIds: [worker],
      decision: { ...issue.decision!, waiting: root },
    };
    const aggregateWith = (workerShell: ReturnType<typeof planned>) => {
      const snapshot = aggregate({
        shells: [planned({ id: root, status: "running", todoProgress: null }), workerShell],
        metadata: [
          { threadId: root, parentThreadId: null, subproject: "on" as const },
          { threadId: worker, parentThreadId: root },
        ],
        issues: new Map([[root, [waitingIssue]]]),
        sources: [],
        plans: [],
        samples: [],
        now,
      });
      const tasks = snapshot.projects.flatMap((project) => project.tasks);
      const steps = tasks.reduce(
        (sum, task) => ({
          done: sum.done + (task.progress?.done ?? 0),
          total: sum.total + (task.progress?.total ?? 0),
        }),
        { done: 0, total: 0 },
      );
      return { tasks, steps };
    };

    it("counts a running worker's steps once, on the issue row only", () => {
      const { tasks, steps } = aggregateWith(
        planned({ id: worker, status: "running", todoProgress: progress }),
      );
      expect(tasks.find((task) => task.url === issue.url)).toMatchObject({
        threadId: root,
        progress: { done: 2, total: 5 },
        nextStep: "Wire the store",
      });
      expect(tasks.map((task) => task.id)).not.toContain(`thread-plan:${worker}`);
      expect(steps).toEqual({ done: 2, total: 5 });
    });

    it("gives a stopped worker its own resumable row without counting its steps again", () => {
      const { tasks, steps } = aggregateWith(
        planned({
          id: worker,
          status: "failed",
          todoProgress: progress,
          planResumeState: stopped,
        }),
      );
      expect(tasks.find((task) => task.id === `thread-plan:${worker}`)).toMatchObject({
        status: "blocked",
        threadId: worker,
        progress: null,
      });
      expect(steps).toEqual({ done: 2, total: 5 });
    });
  });

  it("gives an in-flight linked thread that the issue row does not pick no extra row", () => {
    const sibling = ThreadId.make("sibling");
    const tasks = aggregate({
      shells: [
        planned({ id: root, status: "running", todoProgress: null }),
        planned({ id: child, status: "running", todoProgress: progress }),
        planned({ id: sibling, status: "running", todoProgress: progress }),
      ],
      metadata: [
        { threadId: root, parentThreadId: null, subproject: "on" as const },
        { threadId: child, parentThreadId: root },
        { threadId: sibling, parentThreadId: root },
      ],
      issues: new Map([[root, [{ ...issue, linkedThreadIds: [child, sibling] }]]]),
      sources: [],
      plans: [],
      samples: [],
      now,
    }).projects.flatMap((project) => project.tasks);
    expect(tasks.filter((task) => task.id.startsWith("thread-plan:"))).toEqual([]);
  });

  it("keeps the row of a failed thread whose plan comes only from a PLAN.md", () => {
    // The server enriches such a shell: filePlan plus the todo progress derived from it, and (with
    // the planResumeState fix) the resume state, although the thread never wrote a native todo list.
    const filePlan = {
      planPath: "/plans/a/PLAN.md",
      host: "dev-vm",
      planTitle: "A",
      status: "in progress",
      done: 1,
      total: 4,
      currentStep: { id: "s2", text: "Write the exporter", status: "pending" as const },
      hasResumePoint: true,
    };
    const [task] = rows([
      planned({
        id: root,
        status: "failed",
        filePlan,
        todoProgress: { completed: 1, total: 4, currentStep: filePlan.currentStep },
        planResumeState: stopped,
      }),
    ]);
    expect(task).toMatchObject({
      id: `thread-plan:${root}`,
      status: "blocked",
      progress: { done: 1, total: 4 },
      nextStep: "Write the exporter",
    });
  });

  it("drops a settled stopped thread", () => {
    expect(
      rows([
        planned({
          id: root,
          status: "failed",
          todoProgress: progress,
          planResumeState: stopped,
          settledOverride: "settled",
        }),
      ]),
    ).toEqual([]);
  });
});

describe("file plans in the merged dashboard", () => {
  const plan = (done: number) => ({
    planPath: "/plans/a/PLAN.md",
    host: "dev-vm",
    planTitle: "A",
    status: "in progress",
    done,
    total: 4,
    currentStep: { id: "s", text: "Step", status: "pending" as const },
    hasResumePoint: true,
  });
  const one = EnvironmentId.make("one");
  const two = EnvironmentId.make("two");

  it("keys each environment's plans apart, so one thread id on two servers keeps both", () => {
    const merged = mergeDashboardSnapshots([
      { environmentId: one, snapshot: { ...emptySnapshot(now), filePlans: { t: plan(1) } } },
      { environmentId: two, snapshot: { ...emptySnapshot(now), filePlans: { t: plan(3) } } },
    ]);
    expect(merged.filePlans[filePlanKey(one, "t")]?.done).toBe(1);
    expect(merged.filePlans[filePlanKey(two, "t")]?.done).toBe(3);
  });

  it("is empty for a server that predates file plans", () => {
    expect(
      mergeDashboardSnapshots([{ environmentId: one, snapshot: emptySnapshot(now) }]).filePlans,
    ).toEqual({});
  });

  it("survives compaction", () => {
    expect(compactSnapshot({ ...emptySnapshot(now), filePlans: { t: plan(2) } }).filePlans).toEqual(
      {
        t: plan(2),
      },
    );
  });
});
