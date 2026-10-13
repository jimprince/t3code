import * as DateTime from "effect/DateTime";
import {
  WS_METHODS,
  type DashboardSnapshot,
  type DashboardSource,
  type ForkThreadMetadata,
  type OrchestrationV2ShellSnapshot,
  type ProjectIssue,
  type ProjectPendingAsk,
  type ProjectRoadmap,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { request } from "../rpc/client.ts";
import { aggregate, dashboardRoots, rootRepositories } from "./aggregation.ts";
import { compactSnapshot, issueId } from "./progress.ts";

/** Same reads as Previous's Plan, Roadmap and Decisions; no history is inferred from activity. */
export function composeOlderDashboard(input: {
  shell: OrchestrationV2ShellSnapshot;
  metadata: readonly ForkThreadMetadata[];
  issues: ReadonlyMap<ThreadId, readonly ProjectIssue[]>;
  asks: readonly ProjectPendingAsk[];
  roadmaps: ReadonlyMap<ThreadId, ProjectRoadmap>;
  sources: readonly DashboardSource[];
  now: string;
  revision: number;
  ownRepositories?: ReadonlyMap<ThreadId, string>;
  previous?: DashboardSnapshot;
}): DashboardSnapshot {
  const ownRepositories = new Map(rootRepositories(input.shell));
  for (const [root, roadmap] of input.roadmaps)
    if (roadmap.tracker)
      ownRepositories.set(root, `${roadmap.tracker.host}/${roadmap.tracker.repository}`);
  for (const [root, repository] of input.ownRepositories ?? [])
    ownRepositories.set(root, repository);
  const snapshot = aggregate({
    ...input,
    shells: input.shell.threads,
    plans: [],
    samples: [],
    pendingAsks: input.asks,
    rootRepositories: ownRepositories,
  });
  for (const project of snapshot.projects) {
    const roadmap = project.rootThreadId ? input.roadmaps.get(project.rootThreadId) : undefined;
    if (!roadmap?.tracker) continue;
    const tracker = roadmap.tracker;
    const bands = new Map(
      roadmap.items
        .filter((i) => i.versionId !== null && !i.parked)
        .map((i) => [
          issueId(tracker.host, tracker.repository, i.number),
          `roadmap:${tracker.host}/${tracker.repository}:${i.versionId}`,
        ]),
    );
    const tasks = project.tasks.map((t) => ({
      ...t,
      workstreamId: bands.get(t.id) ?? t.workstreamId,
    }));
    Object.assign(project, {
      tasks,
      workstreams: [...new Set(tasks.map((t) => t.workstreamId))].map((id) => ({
        id,
        title:
          roadmap.versions.find(
            (v) => id === `roadmap:${tracker.host}/${tracker.repository}:${v.id}`,
          )?.title ??
          project.workstreams.find((w) => w.id === id)?.title ??
          "Work",
        taskIds: tasks.filter((t) => t.workstreamId === id).map((t) => t.id),
      })),
    });
  }
  return compactSnapshot({ ...snapshot, revision: input.revision });
}

export const readOlderDashboard = (
  shell: OrchestrationV2ShellSnapshot,
  previous?: DashboardSnapshot,
  reportedVersion?: { readonly version: string; readonly label: string },
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const metadata = yield* request("fork.threads.metadata.list", {});
    const { roots } = dashboardRoots(shell.threads, metadata);
    // A single semaphore covers every RPC across roots, rather than four calls per root.
    const jobs = roots.flatMap((root) => [
      request(WS_METHODS.projectIssuesList, { rootThreadId: root.id }).pipe(
        Effect.map((value) => ({ kind: "issues" as const, root: root.id, value })),
        Effect.option,
      ),
      request(WS_METHODS.projectRoadmapGet, { threadId: root.id }).pipe(
        Effect.map((value) => ({ kind: "roadmap" as const, root: root.id, value })),
        Effect.option,
      ),
      request(WS_METHODS.projectRequestsPendingAsks, { threadId: root.id }).pipe(
        Effect.map((value) => ({ kind: "asks" as const, root: root.id, value })),
        Effect.option,
      ),
    ]);
    const results = yield* Effect.all(jobs, { concurrency: 4 });
    const issues = new Map<ThreadId, readonly ProjectIssue[]>();
    const roadmaps = new Map<ThreadId, ProjectRoadmap>();
    const ownRepositories = new Map<ThreadId, string>();
    const asks: ProjectPendingAsk[] = [];
    const sources = new Map<string, DashboardSource>();
    sources.set("local", {
      id: "local",
      kind: "local",
      observedAt: now,
      lastSuccessAt: now,
      staleAfterMs: 10 * 60_000,
      coverage: "complete",
      failed: false,
      detail: "older server, live movement unavailable",
    });
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const root = roots[Math.floor(i / 3)]!;
      const sourceId = `older:${root.id}:${["issues", "roadmap", "asks"][i % 3]}`;
      const prior = previous?.sources.find((s) => s.id === sourceId);
      sources.set(sourceId, {
        id: sourceId,
        kind: i % 3 === 0 ? "gitea" : "local",
        observedAt: now,
        lastSuccessAt: result._tag === "Some" ? now : (prior?.lastSuccessAt ?? null),
        staleAfterMs: 120_000,
        coverage: result._tag === "Some" ? "bounded" : "unavailable",
        failed: result._tag === "None",
      });
      if (result._tag === "None") {
        if (i % 3 === 0)
          for (const id of previous?.projects.find((p) => p.rootThreadId === root.id)?.sourceIds ??
            []) {
            const prior = previous?.sources.find((s) => s.id === id);
            if (prior?.kind === "gitea")
              sources.set(id, { ...prior, observedAt: now, failed: true, coverage: "unavailable" });
          }
        continue;
      }
      const item = result.value;
      if (item.kind === "issues") {
        issues.set(item.root, item.value.issues);
        if (item.value.primaryRepository)
          ownRepositories.set(
            item.root,
            `${item.value.primaryRepository.host}/${item.value.primaryRepository.repository}`,
          );
        for (const repo of item.value.repositories) {
          const id = `gitea:${repo.host}/${repo.repository}`;
          sources.set(id, {
            id,
            kind: "gitea",
            observedAt: now,
            lastSuccessAt: repo.error
              ? (previous?.sources.find((s) => s.id === id)?.lastSuccessAt ?? null)
              : item.value.fetchedAt,
            staleAfterMs: 120_000,
            coverage: repo.error ? "unavailable" : "bounded",
            failed: !!repo.error,
          });
        }
      } else if (item.kind === "roadmap") roadmaps.set(item.root, item.value);
      else asks.push(...item.value.asks);
    }
    const snapshot = composeOlderDashboard({
      shell,
      metadata,
      issues,
      asks,
      roadmaps,
      ownRepositories,
      sources: [...sources.values()],
      now,
      revision: (previous?.revision ?? 0) + 1,
    });
    for (const project of snapshot.projects) {
      if (!project.rootThreadId) continue;
      const prior = previous?.projects.find((p) => p.id === project.id);
      const issueFailure = sources.get(`older:${project.rootThreadId}:issues`)?.failed;
      const askFailure = sources.get(`older:${project.rootThreadId}:asks`)?.failed;
      const failedRepos = new Set(
        [...sources.values()].filter((s) => s.kind === "gitea" && s.failed).map((s) => s.id),
      );
      if (prior && (issueFailure || askFailure || failedRepos.size)) {
        const retained = prior.tasks.filter(
          (t) =>
            (issueFailure && t.sourceId !== "local") ||
            failedRepos.has(t.sourceId) ||
            (askFailure && t.attentionIds.some((id) => id.startsWith("runtime:"))),
        );
        const tasks = [
          ...project.tasks.filter((t) => !retained.some((old) => old.id === t.id)),
          ...retained,
        ];
        const attention = [
          ...project.attention.filter((a) => !failedRepos.has(a.sourceId)),
          ...prior.attention.filter(
            (a) =>
              (issueFailure && a.sourceId !== "local") ||
              failedRepos.has(a.sourceId) ||
              (askFailure && a.requestId !== null),
          ),
        ];
        Object.assign(project, {
          tasks,
          attention,
          omittedTaskCount: Math.max(project.omittedTaskCount, prior.omittedTaskCount),
          sourceIds: [...new Set([...project.sourceIds, ...prior.sourceIds])],
          workstreams: [...new Set(tasks.map((t) => t.workstreamId))].map((id) => ({
            id,
            title: prior.workstreams.find((w) => w.id === id)?.title ?? "Work",
            taskIds: tasks.filter((t) => t.workstreamId === id).map((t) => t.id),
          })),
        });
      }
      Object.assign(project, {
        sourceIds: [
          ...project.sourceIds,
          ...["issues", "roadmap", "asks"].map((kind) => `older:${project.rootThreadId}:${kind}`),
        ],
      });
    }
    if (reportedVersion) {
      const id = "release:server";
      Object.assign(snapshot, {
        sources: [
          ...snapshot.sources,
          {
            id,
            kind: "release",
            observedAt: now,
            lastSuccessAt: now,
            staleAfterMs: 10 * 60_000,
            coverage: "complete",
            failed: false,
            detail: "Version reported by connected server",
          },
        ],
        releases: [
          {
            id: "server",
            title: reportedVersion.label,
            taskId: null,
            installedVersion: reportedVersion.version,
            latestVersion: null,
            sourceId: id,
          },
        ],
      });
    }
    return compactSnapshot(snapshot);
  });
