import packageJson from "../../package.json" with { type: "json" };
import * as NodeOS from "node:os";
import type {
  DashboardSnapshot,
  DashboardSource,
  ProjectIssue,
  DashboardRelease,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { listMetadata } from "../forkThreads/MetadataStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectIssuesService from "../projectIssues/ProjectIssuesService.ts";
import * as DashboardStore from "./DashboardStore.ts";
import { pendingAsksOfThread } from "../projectIssues/decisionFeed.logic.ts";
import { readPendingRequests } from "../projectIssues/pendingAsks.query.ts";
import { ReleaseHealth } from "./ReleaseSource.ts";
import { aggregate, BriefingPlan, dashboardRoots } from "./aggregation.ts";
import { compactSnapshot, emptySnapshot, sampleProgress } from "./dashboard.logic.ts";
import { singleFlight } from "./DashboardRefresh.ts";

export class DashboardService extends Context.Service<
  DashboardService,
  {
    readonly getSnapshot: Effect.Effect<DashboardSnapshot>;
    readonly stream: (afterRevision?: number) => Stream.Stream<DashboardSnapshot>;
    readonly refresh: Effect.Effect<void>;
  }
>()("t3/dashboard/DashboardService") {}
const make = Effect.gen(function* () {
  const engine = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* ProjectIssuesService.make;
  const store = yield* DashboardStore.DashboardStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const changes = yield* PubSub.sliding<DashboardSnapshot>(1);
  const lock = Semaphore.makeUnsafe(1);
  const saved = yield* store.read.pipe(Effect.orElseSucceed(() => null));
  let snapshot = saved?.snapshot ?? emptySnapshot(DateTime.formatIso(yield* DateTime.now));
  let samples = [...(saved?.samples ?? [])];
  const issueRows = new Map<ThreadId, readonly ProjectIssue[]>(
    Object.entries(saved?.issues ?? {}).map(([id, rows]) => [id as ThreadId, rows]),
  );
  const sources = new Map<string, DashboardSource>(snapshot.sources.map((s) => [s.id, s]));
  const plans = new Map<string, BriefingPlan>(
    (saved?.plans ?? []).map((plan) => [`${plan.head}.json`, plan]),
  );
  // Preserve the persisted projects until each source has completed its first refresh.
  let networkReady = false;
  let releases: readonly DashboardRelease[] =
    saved?.snapshot.releases.filter((r) => r.id !== "server") ?? [];
  const publishLocal = lock
    .withPermit(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const shell = yield* engine.getShellSnapshot();
        const metadata = yield* listMetadata(sql);
        sources.set("local", {
          id: "local",
          kind: "local",
          observedAt: now,
          lastSuccessAt: now,
          staleAfterMs: 60_000,
          coverage: "complete",
          failed: false,
        });
        const pendingAsks = (yield* Effect.forEach(
          shell.threads.filter((t) => t.pendingRuntimeRequest != null).slice(0, 50),
          (thread) =>
            readPendingRequests(sql, thread.id).pipe(
              Effect.map((requests) =>
                pendingAsksOfThread(
                  { id: thread.id, title: thread.title, projectTitle: "" },
                  requests,
                ),
              ),
              Effect.orElseSucceed(() => []),
            ),
          { concurrency: 4 },
        )).flat();
        const next = aggregate({
          shells: shell.threads,
          metadata,
          issues: issueRows,
          plans: [...plans.values()],
          sources: [...sources.values()],
          samples,
          now,
          pendingAsks,
          previous: snapshot,
        });
        if (!networkReady && snapshot.projects.length) {
          // Local startup must not erase last-good network and plan facts.
          return;
        }
        const releaseSource = {
          id: "release:server",
          kind: "release" as const,
          observedAt: now,
          lastSuccessAt: now,
          staleAfterMs: 60_000,
          coverage: "complete" as const,
          failed: false,
        };
        Object.assign(next, {
          sources: [...next.sources, releaseSource],
          releases: [
            ...next.releases,
            ...releases,
            {
              id: "server",
              title: "This environment",
              taskId: null,
              installedVersion: packageJson.version,
              latestVersion: null,
              sourceId: releaseSource.id,
            },
          ],
        });
        const content = (value: DashboardSnapshot) =>
          JSON.stringify({
            projects: value.projects.map((p) => ({
              ...p,
              tasks: p.tasks.map((t) => ({ ...t, movement: { ...t.movement, toAt: "" } })),
            })),
            sources: value.sources.map((s) =>
              s.kind === "local" || s.id === "release:server"
                ? { ...s, observedAt: "", lastSuccessAt: "" }
                : s,
            ),
            releases: value.releases,
          });
        const nextSamples = sampleProgress(
          next.projects.flatMap((p) => p.tasks),
          samples,
          now,
        );
        const changed = content(compactSnapshot(next)) !== content(snapshot);
        const withRevision = changed
          ? { ...compactSnapshot(next), revision: snapshot.revision + 1 }
          : snapshot;
        if (
          !changed &&
          nextSamples.length === samples.length &&
          nextSamples.every((s, i) => s === samples[i])
        )
          return;
        yield* store.write({
          snapshot: withRevision,
          samples: nextSamples,
          issues: Object.fromEntries(issueRows),
          plans: [...plans.values()],
        });
        snapshot = withRevision;
        samples = nextSamples;
        if (changed) yield* PubSub.publish(changes, snapshot);
      }),
    )
    .pipe(Effect.catchCause(() => Effect.logWarning("Dashboard local refresh failed")));
  const refresh = singleFlight(
    Effect.gen(function* () {
      const shell = yield* engine.getShellSnapshot();
      const metadata = yield* listMetadata(sql);
      const { roots } = dashboardRoots(shell.threads, metadata);
      // Roots are serial; the existing repository adapter bounds its network concurrency to four.
      // Its shared repository cache avoids repeated reads for overlapping project scopes.
      for (const root of roots) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const result = yield* issues.list({ rootThreadId: root.id }).pipe(Effect.option);
        if (result._tag === "None") {
          for (const issue of issueRows.get(root.id) ?? []) {
            const id = `gitea:${issue.host}/${issue.repository}`;
            const previous = sources.get(id);
            if (previous) sources.set(id, { ...previous, failed: true, observedAt: now });
          }
          continue;
        }
        const current = result.value;
        const failed = new Set(
          current.repositories
            .filter((r) => r.error !== null)
            .map((r) => `${r.host}/${r.repository}`),
        );
        const previous = issueRows.get(root.id) ?? [];
        issueRows.set(root.id, [
          ...current.issues,
          ...previous.filter((i) => failed.has(`${i.host}/${i.repository}`)),
        ]);
        for (const repo of current.repositories) {
          const id = `gitea:${repo.host}/${repo.repository}`;
          sources.set(id, {
            id,
            kind: "gitea",
            observedAt: now,
            lastSuccessAt: repo.error
              ? (sources.get(id)?.lastSuccessAt ?? null)
              : current.fetchedAt,
            staleAfterMs: 120_000,
            coverage: repo.error ? "unavailable" : "bounded",
            failed: repo.error !== null,
          });
        }
      }
      const directory = path.join(NodeOS.homedir(), ".local/share/briefing/tasks");
      const filenames = yield* fs
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      for (const filename of plans.keys()) {
        if (!filenames.includes(filename)) {
          const id = `plan:${filename.slice(0, -5)}`;
          const previous = sources.get(id);
          if (previous)
            sources.set(id, {
              ...previous,
              failed: true,
              coverage: "unavailable",
              observedAt: DateTime.formatIso(yield* DateTime.now),
            });
        }
      }
      for (const filename of filenames.filter((f) => f.endsWith(".json")).slice(0, 64)) {
        const id = `plan:${filename.slice(0, -5)}`;
        const now = DateTime.formatIso(yield* DateTime.now);
        const plan = yield* fs.readFileString(path.join(directory, filename)).pipe(
          Effect.filterOrFail(
            (contents) => contents.length <= 256_000,
            () => new Error("Plan exceeds size limit"),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(BriefingPlan))),
          Effect.option,
        );
        if (plan._tag === "Some" && Number.isFinite(Date.parse(plan.value.updated_utc))) {
          plans.set(filename, plan.value);
          sources.set(id, {
            id,
            kind: "plan",
            observedAt: now,
            lastSuccessAt: plan.value.updated_utc,
            staleAfterMs: 2 * 60 * 60_000,
            coverage: "complete",
            failed: false,
          });
        } else
          sources.set(id, {
            id,
            kind: "plan",
            observedAt: now,
            lastSuccessAt: sources.get(id)?.lastSuccessAt ?? null,
            staleAfterMs: 2 * 60 * 60_000,
            coverage: "unavailable",
            failed: true,
          });
      }
      const releaseHealth = yield* fs
        .readFileString(path.join(NodeOS.homedir(), ".local/share/reliability/health.json"))
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseHealth))),
          Effect.option,
        );
      if (releaseHealth._tag === "Some") {
        const health = releaseHealth.value.release;
        const releaseObservedAt = DateTime.formatIso(yield* DateTime.now);
        releases = health.installed.hosts
          .filter((host) => Number.isFinite(Date.parse(host.checked_at)))
          .map((host) => {
            const sourceId = `release:${host.host}`;
            sources.set(sourceId, {
              id: sourceId,
              kind: "release",
              observedAt: releaseObservedAt,
              lastSuccessAt: host.checked_at,
              staleAfterMs: 15 * 60_000,
              coverage: "complete",
              failed: false,
            });
            return {
              id: host.host,
              title: host.host,
              taskId: null,
              installedVersion: host.version,
              latestVersion: health.installed.published_tag ?? null,
              sourceId,
            };
          });
        if (health.next_release) {
          const sourceId = "release:forecast";
          const prior = sources.get(sourceId);
          const confirmed =
            health.source?.refreshed_at && Number.isFinite(Date.parse(health.source.refreshed_at))
              ? health.source.refreshed_at
              : (prior?.lastSuccessAt ?? null);
          sources.set(sourceId, {
            id: sourceId,
            kind: "release",
            observedAt: DateTime.formatIso(yield* DateTime.now),
            lastSuccessAt: confirmed,
            staleAfterMs: 15 * 60_000,
            coverage: "bounded",
            failed: false,
          });
          releases = [
            ...releases,
            {
              id: "next-release",
              title: health.next_release.label,
              taskId: null,
              installedVersion: null,
              latestVersion: null,
              sourceId,
              phase: health.next_release.progress,
              eta:
                health.next_release.eta && Number.isFinite(Date.parse(health.next_release.eta))
                  ? health.next_release.eta
                  : null,
              upstreamNightly: health.latest_upstream_nightly ?? null,
              nightlyLagDays: health.upstream_nightly_lag_days ?? null,
              nightlySync: health.nightly_sync?.state ?? null,
            },
          ];
        }
      } else
        for (const release of releases) {
          const previous = sources.get(release.sourceId);
          if (previous)
            sources.set(release.sourceId, {
              ...previous,
              failed: true,
              observedAt: DateTime.formatIso(yield* DateTime.now),
            });
        }
      networkReady = true;
      yield* publishLocal;
    }).pipe(Effect.catchCause(() => Effect.logWarning("Dashboard background refresh failed"))),
  );
  const stream = (afterRevision?: number) =>
    Stream.callback<DashboardSnapshot>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (snapshot.revision !== afterRevision) Queue.offerUnsafe(mailbox, snapshot);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((value) => Effect.sync(() => Queue.offerUnsafe(mailbox, value))),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );
  // Acquisition only loads the durable cache. Network work belongs to scoped background fibers.
  yield* publishLocal;
  yield* refresh.pipe(
    Effect.andThen(Effect.sleep("60 seconds")),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* engine.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type.startsWith("thread.") ||
        event.type === "plan.updated" ||
        event.type === "runtime-request.updated" ||
        (event.type === "turn-item.updated" &&
          (event.payload.type === "user_input_request" ||
            event.payload.type === "approval_request")),
    ),
    Stream.debounce("75 millis"),
    Stream.runForEach(() => publishLocal),
    Effect.forkScoped,
  );
  return DashboardService.of({ getSnapshot: Effect.sync(() => snapshot), stream, refresh });
});
export const layer = Layer.effect(DashboardService, make).pipe(Layer.provide(DashboardStore.layer));
