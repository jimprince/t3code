import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ThreadId,
  type ProjectIssue,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { aggregate } from "./aggregation.ts";
import { composeOlderDashboard } from "./fallback.ts";
import { compactSnapshot, sampleProgress } from "./progress.ts";
import {
  compareDashboardVersions,
  createDashboardSnapshotMerger,
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
      shells: [],
      metadata: [],
      issues: new Map(),
      sources: [],
      samples: [],
      now,
      plans: [
        {
          head: "t3",
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
    expect(release.projects[0]?.tasks[0]?.closedAt).toBe(now);
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
