import { PlanFileService, enrichFilePlanShells } from "../orchestration-v2/PlanFileService.ts";
import * as ShellSnapshotDiagnostics from "../diagnostics/ShellSnapshotDiagnostics.ts";
import packageJson from "../../package.json" with { type: "json" };
import * as NodeOS from "node:os";
import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
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
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectIssuesService from "../projectIssues/ProjectIssuesService.ts";
import * as DashboardStore from "./DashboardStore.ts";
import { pendingAsksOfThread } from "../projectIssues/decisionFeed.logic.ts";
import { readPendingRequests } from "../projectIssues/pendingAsks.query.ts";
import { ReleaseHealth } from "./ReleaseSource.ts";
import {
  aggregate,
  BriefingPlan,
  briefingPlanRoot,
  dashboardRoots,
  rootRepositories,
} from "./aggregation.ts";
import { compactSnapshot, emptySnapshot, sampleProgress } from "./dashboard.logic.ts";
import { confirmTrackerPlan } from "../projectIssues/trackerPlan.logic.ts";
import { singleFlight } from "./DashboardRefresh.ts";

const decodeTrackerHeader = Schema.decodeUnknownOption(
  Schema.Struct({
    source: Schema.Literal("tracker"),
    head: Schema.String,
    title: Schema.String,
    updated_utc: Schema.String,
    rootThreadId: ThreadIdSchema,
  }),
);
const decodeBriefingPlan = Schema.decodeUnknownEffect(BriefingPlan);
export class DashboardService extends Context.Service<
  DashboardService,
  {
    readonly getSnapshot: Effect.Effect<DashboardSnapshot>;
    readonly stream: (afterRevision?: number) => Stream.Stream<DashboardSnapshot>;
    readonly refresh: Effect.Effect<void>;
    readonly refreshAfterWrite: Effect.Effect<void>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/dashboard/DashboardService") {}
export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* ProjectIssuesService.Service;
  const projects = yield* ProjectService.ProjectService;
  const store = yield* DashboardStore.DashboardStore;
  const planFiles = yield* PlanFileService;
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
  const ownRepositories = new Map<ThreadId, string>(
    Object.entries(saved?.rootRepositories ?? {}).map(([id, repository]) => [
      id as ThreadId,
      repository,
    ]),
  );
  const sources = new Map<string, DashboardSource>(snapshot.sources.map((s) => [s.id, s]));
  const plans = new Map<string, BriefingPlan>(
    (saved?.plans ?? []).map((plan) => [plan.fileName ?? `${plan.head}.json`, plan]),
  );
  const trackerRoots = new Set<ThreadId>((saved?.trackerRoots ?? []).map((id) => id as ThreadId));
  let subscribers = 0;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  const refreshRequests = yield* Queue.sliding<void>(1);
  let releases: readonly DashboardRelease[] =
    saved?.snapshot.releases.filter((r) => r.id !== "server") ?? [];
  const publishLocal = lock
    .withPermit(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const shell = yield* engine
          .getShellSnapshot()
          .pipe(ShellSnapshotDiagnostics.withCaller("DashboardService"));
        const metadata = yield* listMetadata(sql);
        sources.set("local", {
          id: "local",
          kind: "local",
          observedAt: now,
          lastSuccessAt: now,
          staleAfterMs: 10 * 60_000,
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
        const shells = enrichFilePlanShells(yield* planFiles.scan, [
          ...shell.threads,
          ...shell.archivedThreads,
        ]);
        const next = {
          ...aggregate({
            shells,
            metadata,
            issues: new Map(
              [...issueRows].map(([id, rows]) => [
                id,
                rows.filter(
                  (i) =>
                    i.closedAt === null ||
                    !i.labels.some((label) => label.toLowerCase() === "withdrawn"),
                ),
              ]),
            ),
            plans: [...plans.values()],
            sources: [...sources.values()],
            samples,
            now,
            pendingAsks,
            previous: snapshot,
            trackerRoots,
            rootRepositories: new Map([
              ...rootRepositories({ ...shell, projects: yield* projects.listShells() }),
              ...ownRepositories,
            ]),
          }),
          filePlans: Object.fromEntries(
            shells.flatMap((t) => (t.filePlan ? [[t.id, t.filePlan]] : [])),
          ),
        };
        const releaseSource = {
          id: "release:server",
          kind: "release" as const,
          observedAt: now,
          lastSuccessAt: now,
          staleAfterMs: 10 * 60_000,
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
                : { ...s, observedAt: "" },
            ),
            releases: value.releases,
            filePlans: value.filePlans,
          });
        const nextSamples = sampleProgress(
          next.projects.flatMap((p) => p.tasks),
          samples,
          now,
        );
        const compact = compactSnapshot(next);
        const changed = content(compact) !== content(snapshot);
        const withRevision = changed
          ? { ...compact, revision: snapshot.revision + 1 }
          : { ...compact, revision: snapshot.revision };
        snapshot = withRevision;
        samples = nextSamples;
        if (Date.parse(now) - lastWriteAt >= 60_000) {
          yield* store.write({
            snapshot,
            samples,
            issues: Object.fromEntries(issueRows),
            plans: [...plans.values()],
            rootRepositories: Object.fromEntries(ownRepositories),
            trackerRoots: [...trackerRoots],
          });
          lastWriteAt = Date.parse(now);
        }
        if (changed) yield* PubSub.publish(changes, snapshot);
      }),
    )
    .pipe(Effect.catchCause(() => Effect.logWarning("Dashboard local refresh failed")));
  let writeRevision = 0;
  const refresh = singleFlight(
    Effect.gen(function* () {
      const shell = yield* engine
        .getShellSnapshot()
        .pipe(ShellSnapshotDiagnostics.withCaller("DashboardService"));
      const metadata = yield* listMetadata(sql);
      const { roots } = dashboardRoots([...shell.threads, ...shell.archivedThreads], metadata);
      const activeRootIds = new Set(roots.map((r) => r.id));
      for (const rootId of issueRows.keys())
        if (!activeRootIds.has(rootId)) issueRows.delete(rootId);
      for (const rootId of ownRepositories.keys())
        if (!activeRootIds.has(rootId)) ownRepositories.delete(rootId);
      const seenSources = new Set<string>(["local", "release:server"]);
      // Roots are serial; the existing repository adapter bounds its network concurrency to four.
      // Its shared repository cache avoids repeated reads for overlapping project scopes.
      for (const root of roots) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const result = yield* issues.list({ rootThreadId: root.id }).pipe(Effect.option);
        if (
          result._tag === "None" ||
          (result.value.repositories.length === 0 && ownRepositories.has(root.id))
        ) {
          const repository = ownRepositories.get(root.id);
          if (repository) {
            const id = `gitea:${repository}`;
            seenSources.add(id);
            const previous = sources.get(id);
            if (previous) sources.set(id, { ...previous, failed: true, observedAt: now });
          }
          for (const issue of issueRows.get(root.id) ?? []) {
            const id = `gitea:${issue.host}/${issue.repository}`;
            seenSources.add(id);
            const previous = sources.get(id);
            if (previous) sources.set(id, { ...previous, failed: true, observedAt: now });
          }
          continue;
        }
        const current = result.value;
        if (current.primaryRepository)
          ownRepositories.set(
            root.id,
            `${current.primaryRepository.host}/${current.primaryRepository.repository}`,
          );
        else ownRepositories.delete(root.id);
        const failed = new Set(
          current.repositories
            .filter((r) => r.error !== null)
            .map((r) => `${r.host}/${r.repository}`),
        );
        const previous = issueRows.get(root.id) ?? [];
        if (
          current.issues.some((issue) => {
            const prior = previous.find(
              (old) =>
                old.host === issue.host &&
                old.repository === issue.repository &&
                old.number === issue.number,
            );
            return (
              issue.plan &&
              (!prior?.plan ||
                issue.plan.evidenceVersion !== prior.plan.evidenceVersion ||
                (issue.plan.confirmedAt != null &&
                  Date.parse(issue.plan.confirmedAt) >
                    Date.parse(prior.plan.confirmedAt ?? "1970-01-01")))
            );
          })
        )
          lastWriteAt = Number.NEGATIVE_INFINITY;
        issueRows.set(root.id, [
          ...current.issues.map((issue) => ({
            ...issue,
            ...(issue.plan
              ? {
                  plan: confirmTrackerPlan(
                    issue.plan,
                    previous.find(
                      (old) =>
                        old.host === issue.host &&
                        old.repository === issue.repository &&
                        old.number === issue.number,
                    )?.plan ?? null,
                    current.fetchedAt,
                  ),
                }
              : {}),
          })),
          ...previous.filter((i) => failed.has(`${i.host}/${i.repository}`)),
        ]);
        for (const repo of current.repositories) {
          const id = `gitea:${repo.host}/${repo.repository}`;
          seenSources.add(id);
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
            ...(repo.noteCoverage && repo.noteCoverage !== "complete"
              ? {
                  detail:
                    repo.noteCoverage === "bounded"
                      ? "Progress notes have partial coverage"
                      : "Progress notes unavailable",
                }
              : {}),
          });
        }
      }
      const planPaths = [
        ".local/share/briefing/tasks",
        ".shared/briefing/tasks",
        ".shared/data/briefing/tasks",
      ];
      let directory: string | null = null;
      for (const candidate of planPaths) {
        const full = path.join(NodeOS.homedir(), candidate);
        if (yield* fs.exists(full)) {
          directory = full;
          break;
        }
      }
      const directoryRead = directory
        ? yield* fs.readDirectory(directory).pipe(Effect.option)
        : { _tag: "Some" as const, value: [] as string[] };
      const filenames = directoryRead._tag === "Some" ? directoryRead.value : [...plans.keys()];
      for (const filename of plans.keys())
        if (!filenames.includes(filename)) plans.delete(filename);
      if (!directory) {
        seenSources.add("plan:host");
        sources.set("plan:host", {
          id: "plan:host",
          kind: "plan",
          observedAt: DateTime.formatIso(yield* DateTime.now),
          lastSuccessAt: null,
          staleAfterMs: 2 * 60 * 60_000,
          coverage: "unavailable",
          failed: false,
          detail: "not on this host",
        });
      }
      for (const filename of filenames.filter((f) => f.endsWith(".json")).slice(0, 64)) {
        const id = `plan:${filename.slice(0, -5)}`;
        const cachedPlan = plans.get(filename);
        if (
          cachedPlan?.source === "tracker" &&
          cachedPlan.rootThreadId &&
          trackerRoots.has(cachedPlan.rootThreadId)
        )
          continue;
        seenSources.add(id);
        const now = DateTime.formatIso(yield* DateTime.now);
        const plan = yield* fs.readFileString(path.join(directory!, filename)).pipe(
          Effect.filterOrFail(
            (contents) => contents.length <= 256_000,
            () => new Error("Plan exceeds size limit"),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
          Effect.flatMap((value) => {
            const header = decodeTrackerHeader(value);
            if (header._tag === "Some") return Effect.succeed({ ...header.value, workstreams: [] });
            return decodeBriefingPlan(value);
          }),
          Effect.option,
        );
        if (plan._tag === "Some" && Number.isFinite(Date.parse(plan.value.updated_utc))) {
          const rootId = briefingPlanRoot(plan.value, roots);
          // Never turn a title match into the explicit id required for tracker cutover.
          const bound =
            rootId && plan.value.source !== "tracker"
              ? { ...plan.value, rootThreadId: rootId }
              : plan.value;
          if (
            rootId &&
            plan.value.rootThreadId &&
            plan.value.source === "tracker" &&
            !trackerRoots.has(rootId)
          ) {
            trackerRoots.add(rootId);
            lastWriteAt = Number.NEGATIVE_INFINITY;
          }
          if (!rootId || !trackerRoots.has(rootId) || plan.value.source === "tracker")
            plans.set(filename, { ...bound, fileName: filename });
          else plans.delete(filename);
          sources.set(id, {
            id,
            kind: "plan",
            observedAt: now,
            lastSuccessAt: plan.value.updated_utc,
            staleAfterMs: 2 * 60 * 60_000,
            coverage: "complete",
            failed: plan.value.source === "tracker" && !rootId,
            ...(plan.value.source === "tracker" && !rootId
              ? { detail: `Unbound briefing file: ${filename}` }
              : {}),
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
      let healthPath: string | null = null;
      for (const candidate of [
        ".local/share/reliability/health.json",
        ".shared/reliability/health.json",
        ".shared/data/reliability/health.json",
      ]) {
        const full = path.join(NodeOS.homedir(), candidate);
        if (yield* fs.exists(full)) {
          healthPath = full;
          break;
        }
      }
      const releaseHealth = healthPath
        ? yield* fs
            .readFileString(healthPath)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseHealth))),
              Effect.option,
            )
        : { _tag: "None" as const };
      if (!healthPath) {
        releases = [];
        seenSources.add("release:host");
        sources.set("release:host", {
          id: "release:host",
          kind: "release",
          observedAt: DateTime.formatIso(yield* DateTime.now),
          lastSuccessAt: null,
          staleAfterMs: 15 * 60_000,
          coverage: "unavailable",
          failed: false,
          detail: "not on this host",
        });
      }
      if (releaseHealth._tag === "Some") {
        const health = releaseHealth.value.release;
        const releaseObservedAt = DateTime.formatIso(yield* DateTime.now);
        releases = health.installed.hosts
          .filter((host) => Number.isFinite(Date.parse(host.checked_at)))
          .map((host) => {
            const sourceId = `release:${host.host}`;
            seenSources.add(sourceId);
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
          seenSources.add(sourceId);
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
          seenSources.add(release.sourceId);
          const previous = sources.get(release.sourceId);
          if (previous)
            sources.set(release.sourceId, {
              ...previous,
              failed: true,
              observedAt: DateTime.formatIso(yield* DateTime.now),
            });
        }
      for (const id of sources.keys()) if (!seenSources.has(id)) sources.delete(id);
      yield* publishLocal;
    }).pipe(Effect.catchCause(() => Effect.logWarning("Dashboard background refresh failed"))),
    () => writeRevision,
  );
  const stream = (afterRevision?: number) =>
    Stream.callback<DashboardSnapshot>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              subscribers++;
            }),
            () =>
              Effect.sync(() => {
                subscribers--;
              }),
          );
          if (subscribers === 1) yield* Queue.offer(refreshRequests, undefined);
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
  yield* Effect.suspend(() => (subscribers > 0 ? refresh : Effect.void)).pipe(
    Effect.andThen(Effect.sleep("60 seconds")),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(refreshRequests).pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );
  yield* engine.streamDomainEvents.pipe(
    // Resolving a question must publish even if subsequent thread events keep arriving
    // or the tracker refresh is blocked. Runtime answers have their own debounce.
    Stream.filter(
      (event) =>
        event.type === "runtime-request.updated" ||
        (event.type === "turn-item.updated" &&
          (event.payload.type === "user_input_request" ||
            event.payload.type === "approval_request")),
    ),
    Stream.debounce("75 millis"),
    Stream.runForEach(() => publishLocal),
    Effect.forkScoped,
  );
  yield* engine.streamDomainEvents.pipe(
    Stream.filter((event) => event.type.startsWith("thread.") || event.type === "plan.updated"),
    Stream.debounce("75 millis"),
    Stream.runForEach(() => publishLocal),
    Effect.forkScoped,
  );
  return DashboardService.of({
    getSnapshot: Effect.sync(() => snapshot),
    stream,
    refresh,
    refreshAfterWrite: Effect.sync(() => {
      writeRevision++;
    }).pipe(Effect.andThen(refresh)),
    invalidate: Queue.offer(refreshRequests, undefined).pipe(Effect.asVoid),
  });
});
export const layer = Layer.effect(DashboardService, make).pipe(Layer.provide(DashboardStore.layer));
