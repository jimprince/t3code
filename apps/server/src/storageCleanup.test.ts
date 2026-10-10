import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type WorktreeCleanupRules,
  IsoDateTime,
  EventId,
  ProviderSessionId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { make, storageCleanupActivityAt, storageCleanupThreadIdle } from "./storageCleanup.ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Git from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Projects from "./orchestration-v2/ProjectStore.ts";
import * as Projections from "./orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as Terminals from "./terminal/Manager.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

const encodeThread = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const encodeSession = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ProviderSessionJson));

const fixtureLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-sweep-" }),
  NodeSqliteClient.layer({ filename: ":memory:" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const runSweepFixture = (input: {
  rules: Partial<WorktreeCleanupRules>;
  repositories: number;
  worktreesPerRepository: number;
  recent?: boolean;
  dirty?: boolean;
  unpushed?: boolean;
  dirtyBeforeRemoval?: boolean;
  missingDefaultBranch?: boolean;
  sweeps?: number;
  scheduled?: boolean;
  merged?: boolean;
  event?: "session" | "delete" | "burst";
  liveSession?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let launches = 0;
    const rawDriver = yield* Git.make.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
        ...spawner,
        spawn: (command) => {
          launches++;
          return spawner.spawn(command);
        },
      }),
    );
    let contextProbes = { remote: 0, defaultBranch: 0, fetch: 0 };
    const driver: Git.GitVcsDriver["Service"] = {
      ...rawDriver,
      resolvePrimaryRemoteName: (cwd) =>
        rawDriver.resolvePrimaryRemoteName(cwd).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              contextProbes.remote++;
            }),
          ),
        ),
      resolveDefaultBranchName: (cwd, remote) =>
        rawDriver.resolveDefaultBranchName(cwd, remote).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              contextProbes.defaultBranch++;
            }),
          ),
        ),
      fetchRemoteTrackingBranch: (input) =>
        rawDriver.fetchRemoteTrackingBranch(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              contextProbes.fetch++;
            }),
          ),
        ),
    };
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      driver.execute({
        operation: "StorageCleanup.test.fixture",
        cwd,
        args,
      });
    const projects: OrchestrationProjectShell[] = [];
    const threads: OrchestrationV2ThreadShell[] = [];
    for (let repository = 0; repository < input.repositories; repository++) {
      const cwd = `${config.baseDir}/repository-${repository}`;
      yield* fs.makeDirectory(cwd);
      yield* git(cwd, ["init", "-b", "main"]);
      yield* git(cwd, ["config", "user.name", "Cleanup test"]);
      yield* git(cwd, ["config", "user.email", "cleanup@example.test"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "initial"]);
      yield* git(cwd, ["remote", "add", "origin", cwd]);
      yield* git(cwd, ["fetch", "origin", "main:refs/remotes/origin/main"]);
      if (!input.missingDefaultBranch) {
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      }
      const projectId = ProjectId.make(`project-${repository}`);
      projects.push({
        id: projectId,
        title: "Repository",
        workspaceRoot: cwd,
        repositoryIdentity: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: IsoDateTime.make(DateTime.formatIso(at(0))),
        updatedAt: IsoDateTime.make(DateTime.formatIso(at(0))),
      });
      for (let index = 0; index < input.worktreesPerRepository; index++) {
        const branch = `feature-${repository}-${index}`;
        const worktreePath = `${config.worktreesDir}/${branch}`;
        yield* git(cwd, ["worktree", "add", "-b", branch, worktreePath]);
        if (input.dirty) yield* fs.writeFileString(`${worktreePath}/keep.txt`, "local work");
        if (input.unpushed) yield* git(worktreePath, ["commit", "--allow-empty", "-m", "unpushed"]);
        threads.push(
          shell({
            id: ThreadId.make(branch),
            projectId,
            branch,
            worktreePath,
            createdAt: input.recent ? yield* DateTime.now : at(-30 * DAY_MS),
          }),
        );
      }
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT, project_id TEXT, deleted_at TEXT)`;
    yield* sql`CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)`;
    for (const project of projects) {
      yield* sql`INSERT INTO projection_projects VALUES (${project.id}, ${project.workspaceRoot})`;
    }
    const firstRead = yield* Deferred.make<void>();
    const eventRead = yield* Deferred.make<void>();
    const releaseEventRead = yield* Deferred.make<void>();
    const eventBatches = yield* Queue.unbounded<{
      events: ReadonlyArray<OrchestrationV2DomainEvent>;
      receipt: Deferred.Deferred<void>;
    }>();
    const events = Stream.fromQueue(eventBatches).pipe(
      Stream.flatMap((batch) =>
        Stream.concat(
          Stream.fromIterable(batch.events),
          Stream.fromEffect(Deferred.succeed(batch.receipt, undefined)).pipe(Stream.drain),
        ),
      ),
    );
    let reads = 0;
    let eventPhase = false;
    const cleanup = yield* make.pipe(
      Effect.provideService(Git.GitVcsDriver, driver),
      Effect.provide(
        Layer.mock(Projects.ProjectStoreV2)({ listShells: () => Effect.succeed(projects) }),
      ),
      Effect.provide(
        Layer.mock(Projections.ProjectionStoreV2)({
          getShellSnapshot: (options) =>
            Effect.gen(function* () {
              reads++;
              yield* Deferred.succeed(firstRead, undefined);
              if (eventPhase && input.event === "burst" && options?.location !== "archive") {
                yield* Deferred.succeed(eventRead, undefined);
                yield* Deferred.await(releaseEventRead);
              }
              if (input.dirtyBeforeRemoval && reads === 3) {
                yield* fs
                  .writeFileString(`${threads[0]!.worktreePath}/keep.txt`, "new local work")
                  .pipe(Effect.orDie);
              }
              return {
                schemaVersion: 1,
                snapshotSequence: 0,
                archivedThreads: [],
                threads: options?.location === "archive" ? [] : threads,
              };
            }),
        }),
      ),
      Effect.provide(
        Layer.mock(GitManager.GitManager)({
          invalidateStatus: () => Effect.void,
          branchPullRequest: ({ branch }) =>
            Effect.succeed(
              input.merged
                ? {
                    number: 1,
                    title: "Merged",
                    url: "https://example.test/pr/1",
                    state: "merged" as const,
                    baseRef: "main",
                    headRef: branch,
                    repositoryKey: null,
                    updatedAt: null,
                  }
                : null,
            ),
        }),
      ),
      Effect.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: events })),
      Effect.provide(
        Layer.mock(Terminals.TerminalManager)({
          subscribeMetadata: () => Effect.succeed(() => {}),
        }),
      ),
      Effect.provide(
        Settings.layerTest({
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: null,
              worktreeOnMerge: false,
              worktreeOnDelete: false,
              worktreeUnchanged: false,
              ...input.rules,
            },
          },
          storageCleanup: { browserArtifactsAfterDays: null, logsAfterDays: null },
        }),
      ),
    );
    const counts: number[] = [];
    const contexts: (typeof contextProbes)[] = [];
    if (input.scheduled || input.event) {
      launches = 0;
      yield* cleanup.start();
      yield* Deferred.await(firstRead);
      yield* cleanup.drain;
      if (input.scheduled) {
        counts.push(launches);
        const retained = yield* Effect.forEach(threads, (thread) =>
          fs.exists(thread.worktreePath!),
        );
        return { counts, retained, reads, contexts };
      }
    }
    if (input.event) {
      // The initial scheduled sweep sees young candidates. Age them afterwards
      // so an accidentally full event sweep would remove their checkouts.
      for (let index = 0; index < threads.length; index++) {
        threads[index] = { ...threads[index]!, createdAt: at(-30 * DAY_MS) };
      }
      const target = threads[threads.length - 1]!;
      const event: OrchestrationV2DomainEvent =
        input.event === "delete"
          ? {
              type: "thread.deleted",
              id: EventId.make("delete"),
              threadId: target.id,
              occurredAt: at(0),
              payload: { ...target, lastVisitedAt: target.lastVisitedAt ?? null, deletedAt: at(0) },
            }
          : {
              type: "provider-session.updated",
              id: EventId.make("session"),
              threadId: target.id,
              occurredAt: at(0),
              payload: {
                id: ProviderSessionId.make("session"),
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                status: "stopped",
                cwd: target.worktreePath!,
                model: null,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: at(0),
                updatedAt: at(0),
                lastError: null,
              },
            };
      if (input.liveSession) {
        const payload = encodeSession({
          id: ProviderSessionId.make("live-session"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
          cwd: target.worktreePath!,
          model: null,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: at(0),
          updatedAt: at(0),
          lastError: null,
        });
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES (${payload}, 'ready')`;
      }
      if (input.event === "delete" || input.event === "burst") {
        if (input.event === "burst") {
          yield* fs.writeFileString(`${target.worktreePath}/keep.txt`, "local work");
        }
        const payload = encodeThread({
          ...target,
          lastVisitedAt: target.lastVisitedAt ?? null,
          deletedAt: at(0),
        });
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${payload}, ${target.projectId}, 'deleted')`;
        threads.pop();
      }
      const send = (count: number) =>
        Effect.gen(function* () {
          const receipt = yield* Deferred.make<void>();
          yield* Queue.offer(eventBatches, { events: Array(count).fill(event), receipt });
          yield* Deferred.await(receipt);
        });
      launches = 0;
      reads = 0;
      eventPhase = true;
      yield* send(1);
      if (input.event === "burst") {
        yield* Deferred.await(eventRead);
        yield* send(20);
        yield* Deferred.succeed(releaseEventRead, undefined);
      }
      yield* cleanup.drain;
      counts.push(launches);
      const retained = yield* Effect.forEach(
        [...threads, ...(input.event === "delete" || input.event === "burst" ? [target] : [])],
        (thread) => fs.exists(thread.worktreePath!),
      );
      return { counts, retained, reads, contexts };
    }
    for (let sweep = 0; sweep < (input.sweeps ?? 1); sweep++) {
      launches = 0;
      contextProbes = { remote: 0, defaultBranch: 0, fetch: 0 };
      yield* cleanup.sweep();
      contexts.push(contextProbes);
      counts.push(launches);
    }
    const retained = yield* Effect.forEach(threads, (thread) => fs.exists(thread.worktreePath!));
    return { counts, retained, reads, contexts };
  }).pipe(Effect.scoped, Effect.provide(fixtureLayer));

describe("storage cleanup sweeps", () => {
  effectIt.live("launches no Git processes for 6 young worktrees across 2 repositories", () =>
    Effect.gen(function* () {
      const result = yield* runSweepFixture({
        rules: { worktreeAfterDays: 7 },
        repositories: 2,
        worktreesPerRepository: 3,
        recent: true,
      });
      expect(result.counts).toEqual([0]);
      expect(result.retained).toEqual(Array(6).fill(true));
    }),
  );

  effectIt.live("keeps the same age cleanup decisions", () =>
    Effect.gen(function* () {
      const old = yield* runSweepFixture({
        rules: { worktreeAfterDays: 7 },
        repositories: 1,
        worktreesPerRepository: 1,
      });
      const young = yield* runSweepFixture({
        rules: { worktreeAfterDays: 7 },
        repositories: 1,
        worktreesPerRepository: 1,
        recent: true,
      });
      expect(old.retained).toEqual([false]);
      expect(young.retained).toEqual([true]);
    }),
  );

  effectIt.live.each([{ dirty: true }, { unpushed: true }, { dirtyBeforeRemoval: true }])(
    "protects local work: %j",
    (safety) =>
      Effect.gen(function* () {
        const result = yield* runSweepFixture({
          rules: { worktreeUnchanged: true },
          repositories: 1,
          worktreesPerRepository: 1,
          ...safety,
        });
        expect(result.retained).toEqual([true]);
        expect(result.counts[0]).toBeGreaterThan(0);
      }),
  );

  effectIt.live(
    "reuses a successful missing-default probe in one sweep and probes again next sweep",
    () =>
      Effect.gen(function* () {
        const result = yield* runSweepFixture({
          rules: { worktreeUnchanged: true },
          repositories: 2,
          worktreesPerRepository: 3,
          missingDefaultBranch: true,
          sweeps: 2,
        });
        expect(result.retained).toEqual(Array(6).fill(true));
        expect(result.contexts).toEqual(
          Array.from({ length: 2 }, () => ({ remote: 2, defaultBranch: 2, fetch: 0 })),
        );
      }),
  );
});

describe("storage cleanup event scope", () => {
  effectIt.live("a provider-session update does not launch Git for age candidates", () =>
    Effect.gen(function* () {
      const result = yield* runSweepFixture({
        rules: { worktreeOnDelete: true, worktreeAfterDays: 7 },
        repositories: 2,
        worktreesPerRepository: 3,
        recent: true,
        event: "session",
      });
      expect(result.counts).toEqual([0]);
      expect(result.retained).toEqual(Array(6).fill(true));
      expect(result.reads).toBe(0);
    }),
  );

  effectIt.live("a deleted thread is reclaimed without sweeping the other old worktrees", () =>
    Effect.gen(function* () {
      const result = yield* runSweepFixture({
        rules: { worktreeOnDelete: true, worktreeAfterDays: 7 },
        repositories: 2,
        worktreesPerRepository: 3,
        recent: true,
        event: "delete",
      });
      expect(result.retained).toEqual([true, true, true, true, true, false]);
      expect(result.counts[0]).toBeGreaterThan(0);
    }),
  );

  effectIt.live("coalesces session updates received while a deletion sweep is running", () =>
    Effect.gen(function* () {
      const result = yield* runSweepFixture({
        rules: { worktreeOnDelete: true, worktreeAfterDays: 7 },
        repositories: 2,
        worktreesPerRepository: 3,
        recent: true,
        event: "burst",
      });
      expect(result.counts[0]).toBeGreaterThan(0);
      expect(result.retained).toEqual(Array(6).fill(true));
      expect(result.reads).toBe(4); // Current pass plus one trailing pass, two shell reads each.
    }),
  );

  effectIt.live.each([
    { worktreeAfterDays: 7 },
    { worktreeUnchanged: true },
    { worktreeOnMerge: true },
  ])("the scheduled full sweep still applies %j", (rules) =>
    Effect.gen(function* () {
      const result = yield* runSweepFixture({
        rules,
        repositories: 1,
        worktreesPerRepository: 1,
        scheduled: true,
        merged: true,
      });
      expect(result.retained).toEqual([false]);
      expect(result.counts[0]).toBeGreaterThan(0);
    }),
  );
});

effectIt.live("resolves and fetches each successful repository context once per sweep", () =>
  Effect.gen(function* () {
    const result = yield* runSweepFixture({
      rules: { worktreeUnchanged: true },
      repositories: 2,
      worktreesPerRepository: 3,
      unpushed: true,
      sweeps: 2,
    });
    expect(result.contexts).toEqual(
      Array.from({ length: 2 }, () => ({ remote: 2, defaultBranch: 2, fetch: 2 })),
    );
    expect(result.retained).toEqual(Array(6).fill(true));
  }),
);

effectIt.live("retains a deleted worktree while a live provider session still owns its cwd", () =>
  Effect.gen(function* () {
    const result = yield* runSweepFixture({
      rules: { worktreeOnDelete: true, worktreeAfterDays: 7 },
      repositories: 1,
      worktreesPerRepository: 2,
      recent: true,
      event: "delete",
      liveSession: true,
    });
    expect(result.retained).toEqual([true, true]);
  }),
);
