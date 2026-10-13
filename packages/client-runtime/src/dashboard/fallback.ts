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
import * as Option from "effect/Option";
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

// Older hosts serve tracker reads uncached; fork.12 on the VM measured ~24 s per
// projectIssues.list. The first revision is published before these reads, so a
// generous deadline only delays enrichment instead of dropping the data.
const TRACKER_READ_DEADLINE = "60 seconds";

export const readOlderDashboard = (
  shell: OrchestrationV2ShellSnapshot,
  previous?: DashboardSnapshot,
  reportedVersion?: { readonly version: string; readonly label: string },
  emit: (snapshot: DashboardSnapshot) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    // Even metadata must settle: an older/slow host must not leave the environment at revision 0.
    const metadataResult = yield* request("fork.threads.metadata.list", {}).pipe(
      Effect.timeout("15 seconds"),
      Effect.option,
    );
    const metadata = Option.getOrElse(metadataResult, () => []);
    const { roots } = dashboardRoots(shell.threads, metadata);
    // A single semaphore covers every RPC across roots, rather than four calls per root.
    const jobs = roots.flatMap((root) => [
      request(WS_METHODS.projectIssuesList, { rootThreadId: root.id }).pipe(
        Effect.map((value) => ({ kind: "issues" as const, root: root.id, value })),
        Effect.timeout(TRACKER_READ_DEADLINE),
        Effect.option,
      ),
      request(WS_METHODS.projectRoadmapGet, { threadId: root.id }).pipe(
        Effect.map((value) => ({ kind: "roadmap" as const, root: root.id, value })),
        Effect.timeout(TRACKER_READ_DEADLINE),
        Effect.option,
      ),
      request(WS_METHODS.projectRequestsPendingAsks, { threadId: root.id }).pipe(
        Effect.map((value) => ({ kind: "asks" as const, root: root.id, value })),
        Effect.timeout(TRACKER_READ_DEADLINE),
        Effect.option,
      ),
    ]);
    type Result = Option.Option<Option.Option.Value<Effect.Success<(typeof jobs)[number]>>>;
    const pending: readonly Result[] = jobs.map(() => Option.none());
    const now = DateTime.formatIso(yield* DateTime.now);
    let revision = previous?.revision ?? 0;
    const build = (results: readonly Result[], completed: number) => {
      const issues = new Map<ThreadId, readonly ProjectIssue[]>();
      const roadmaps = new Map<ThreadId, ProjectRoadmap>();
      const ownRepositories = new Map<ThreadId, string>();
      const asks: ProjectPendingAsk[] = [];
      const sources = new Map<string, DashboardSource>();
      sources.set("older:metadata", {
        id: "older:metadata",
        kind: "local",
        observedAt: now,
        lastSuccessAt: Option.isSome(metadataResult)
          ? now
          : (previous?.sources.find((s) => s.id === "older:metadata")?.lastSuccessAt ?? null),
        staleAfterMs: 120_000,
        coverage: Option.isSome(metadataResult) ? "complete" : "unavailable",
        failed: Option.isNone(metadataResult),
        detail: Option.isNone(metadataResult) ? "Metadata read failed or timed out" : null,
      });
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
        const settled = i < completed;
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
          failed: settled && result._tag === "None",
          detail:
            result._tag === "None" ? (settled ? "Read failed or timed out" : "Read pending") : null,
        });
        if (result._tag === "None") {
          if (i % 3 === 0)
            for (const id of previous?.projects.find((p) => p.rootThreadId === root.id)
              ?.sourceIds ?? []) {
              const prior = previous?.sources.find((s) => s.id === id);
              if (prior?.kind === "gitea")
                sources.set(id, {
                  ...prior,
                  observedAt: now,
                  failed: settled,
                  coverage: "unavailable",
                });
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
        revision: ++revision,
      });
      for (const project of snapshot.projects) {
        if (!project.rootThreadId) continue;
        const prior = previous?.projects.find((p) => p.id === project.id);
        const issueFailure =
          sources.get(`older:${project.rootThreadId}:issues`)?.coverage === "unavailable";
        const askFailure =
          sources.get(`older:${project.rootThreadId}:asks`)?.coverage === "unavailable";
        const failedRepos = new Set(
          [...sources.values()]
            .filter((s) => s.kind === "gitea" && s.coverage === "unavailable")
            .map((s) => s.id),
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
            "older:metadata",
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
      // Missing metadata cannot prove projects disappeared. Keep the last coherent tree, marked unknown.
      if (Option.isNone(metadataResult) && previous)
        Object.assign(snapshot, {
          projects: previous.projects,
          sources: [
            ...previous.sources
              .filter(
                (s) => s.id !== "older:metadata" && (!reportedVersion || s.id !== "release:server"),
              )
              .map((s) => ({
                ...s,
                observedAt: now,
                coverage: "unavailable" as const,
                failed: true,
              })),
            sources.get("older:metadata")!,
            ...snapshot.sources.filter((s) => s.kind === "release"),
          ],
        });
      return compactSnapshot(snapshot);
    };
    // Shell + metadata identify the heads without waiting for remote trackers. Every emitted value
    // is a complete snapshot, so Plan, Decisions and Releases always swap together.
    const core = build(pending, 0);
    if (jobs.length === 0) return core;
    yield* emit(core);
    // Publish bounded enrichment batches too: the minute refresh can interrupt a large pass,
    // and completed/expired sources must become visible before that happens.
    const results = [...pending];
    for (let start = 0; start < jobs.length; start += 12) {
      const batch = yield* Effect.all(jobs.slice(start, start + 12), { concurrency: 4 });
      results.splice(start, batch.length, ...batch);
      const snapshot = build(results, start + batch.length);
      if (start + batch.length === jobs.length) return snapshot;
      yield* emit(snapshot);
    }
    return core;
  });
