import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ProjectDashboard from "../projectDashboard/ProjectDashboardService.ts";
import { parseDashboardFile } from "../projectDashboard/projectDashboard.logic.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { initializeMetadata, listMetadata, writeMetadata } from "./MetadataStore.ts";
import { makeNestingService } from "./NestingService.ts";
import { findProjectRootThreadId } from "../projectIssues/projectIssues.logic.ts";
const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "subprojects-native" },
  ProviderAdapterRegistry.layerFromAdapters([]),
  { databaseLayer: database, runEffectWorker: false },
);
const nativeLayer = ThreadManagement.layer.pipe(
  Layer.provide(runtime),
  Layer.provideMerge(database),
);
const id = ThreadId.make;
it.effect(
  "native child creation stays inert, explicit modes survive restart and unchanged mode preserves the shell timestamp",
  () =>
    Effect.gen(function* () {
      const management = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const nesting = yield* makeNestingService(
        sql,
        management.getThreadShell,
        management.dispatch,
      );
      for (const name of ["top", "mid", "worker"]) {
        yield* management.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${name}`),
          threadId: id(name),
          projectId: ProjectId.make("project"),
          title: name,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        if (name !== "top")
          yield* nesting.update({
            commandId: CommandId.make(`nest-${name}`),
            threadId: id(name),
            parentThreadId: id(name === "mid" ? "top" : "mid"),
          });
      }
      assert.equal(
        (yield* nesting.list()).find((row) => row.threadId === id("mid"))?.subproject ?? "auto",
        "auto",
      );
      yield* nesting.update({
        commandId: CommandId.make("mark-mid"),
        threadId: id("mid"),
        subproject: "on",
      });
      const shell = (yield* management.getThreadShell(id("mid")))!;
      yield* TestClock.adjust("1 minute");
      yield* nesting.update({
        commandId: CommandId.make("mark-mid-again"),
        threadId: id("mid"),
        subproject: "on",
      });
      assert.equal(
        DateTime.formatIso((yield* management.getThreadShell(id("mid")))!.updatedAt),
        DateTime.formatIso(shell.updatedAt),
      );
      const restarted = yield* makeNestingService(
        sql,
        management.getThreadShell,
        management.dispatch,
      );
      const scoped = (yield* management.getShellSnapshot()).threads;
      const rows = yield* restarted.list();
      const threads = scoped.map((thread) => ({
        ...thread,
        parentThreadId: rows.find((row) => row.threadId === thread.id)?.parentThreadId ?? null,
        subproject: rows.find((row) => row.threadId === thread.id)?.subproject ?? "auto",
      }));
      assert.equal(findProjectRootThreadId(threads, id("worker")), id("mid"));
      let dashboardFile = parseDashboardFile(null);
      const dashboards = yield* ProjectDashboard.make(
        {
          read: Effect.sync(() => dashboardFile),
          modify: (change) =>
            Effect.sync(() => {
              dashboardFile = change(dashboardFile);
              return dashboardFile;
            }),
        },
        {
          get: (threadId: ThreadId) =>
            Effect.succeed({ rootThreadId: threadId, revision: 0, tabs: [] }),
        } as never,
      ).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            giteaInstances: [
              {
                id: "test",
                host: "git.test",
                webOrigin: "https://git.test",
                apiOrigin: "https://git.test",
                token: "fake",
                sshAliases: [],
                sshPorts: [22],
              },
            ],
          }),
        ),
      );
      yield* dashboards.setTracker({ threadId: id("top"), tracker: "brad/parent" });
      assert.equal((yield* dashboards.get({ threadId: id("worker") })).tracker, "brad/parent");
      yield* dashboards.setTracker({ threadId: id("worker"), tracker: "brad/child" });
      assert.equal((yield* dashboards.get({ threadId: id("top") })).tracker, "brad/parent");
      assert.equal((yield* dashboards.get({ threadId: id("worker") })).tracker, "brad/child");
      assert.deepEqual(dashboardFile.trackers, { project: "brad/parent", mid: "brad/child" });

      assert.equal((yield* management.getThreadShell(id("worker")))!.lineage.parentThreadId, null);
      for (const mode of ["off", "auto"] as const) {
        yield* restarted.update({
          commandId: CommandId.make(`mode-${mode}`),
          threadId: id("mid"),
          subproject: mode,
        });
        assert.equal(
          (yield* restarted.list()).find((row) => row.threadId === id("mid"))?.subproject,
          mode,
        );
      }
      yield* management.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-mid"),
        threadId: id("mid"),
      });
      assert.equal(
        (yield* Effect.exit(
          restarted.update({
            commandId: CommandId.make("mark-archived"),
            threadId: id("mid"),
            subproject: "on",
          }),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(nativeLayer)),
);

const makeThreads = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const management = yield* ThreadManagement.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const nesting = yield* makeNestingService(sql, management.getThreadShell, management.dispatch, {
      autoPromoteSubprojects: true,
    });
    for (const name of names)
      yield* management.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-${name}`),
        threadId: id(name),
        projectId: ProjectId.make("project"),
        title: name,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    const nest = (child: string, parent: string | null, commandId = `nest-${child}-${parent}`) =>
      nesting.update({
        commandId: CommandId.make(commandId),
        threadId: id(child),
        parentThreadId: parent === null ? null : id(parent),
      });
    const mode = (name: string) =>
      nesting
        .list()
        .pipe(
          Effect.map((rows) => rows.find((row) => row.threadId === id(name))?.subproject ?? "auto"),
        );
    return { nesting, nest, mode };
  });

it.effect("a nested thread is promoted when a worker is created under it or moved into it", () =>
  Effect.gen(function* () {
    const { nest, mode } = yield* makeThreads(["top", "mid", "moved", "fresh"]);
    yield* nest("mid", "top");
    assert.equal(yield* mode("mid"), "auto");
    // Moving an existing top-level thread under it promotes the new parent, once.
    yield* nest("moved", "mid");
    assert.equal(yield* mode("mid"), "on");
    // The child itself and the top-level thread above it stay unpromoted.
    assert.equal(yield* mode("moved"), "auto");
    assert.equal(yield* mode("top"), "auto");
    // Leaving again does not demote it.
    yield* nest("moved", null);
    assert.equal(yield* mode("mid"), "on");
    yield* nest("fresh", "mid");
    assert.equal(yield* mode("mid"), "on");
  }).pipe(Effect.provide(nativeLayer)),
);

it.effect(
  "off blocks promotion, on and explicit auto behave as documented, top-level is never promoted",
  () =>
    Effect.gen(function* () {
      const { nesting, nest, mode } = yield* makeThreads([
        "top",
        "off",
        "on",
        "auto",
        "w1",
        "w2",
        "w3",
        "w4",
      ]);
      for (const name of ["off", "on", "auto"]) yield* nest(name, "top");
      for (const [name, value] of [
        ["off", "off"],
        ["on", "on"],
        ["auto", "auto"],
      ] as const)
        yield* nesting.update({
          commandId: CommandId.make(`mode-${name}`),
          threadId: id(name),
          subproject: value,
        });
      yield* nest("w1", "off");
      yield* nest("w2", "on");
      yield* nest("w3", "auto");
      yield* nest("w4", "top");
      assert.equal(yield* mode("off"), "off");
      assert.equal(yield* mode("on"), "on");
      assert.equal(yield* mode("auto"), "on");
      assert.equal(yield* mode("top"), "auto");
    }).pipe(Effect.provide(nativeLayer)),
);

it.effect("replaying a nesting command does not undo a later opt-out", () =>
  Effect.gen(function* () {
    const { nesting, nest, mode } = yield* makeThreads(["top", "mid", "worker"]);
    yield* nest("mid", "top");
    yield* nest("worker", "mid", "nest-worker");
    assert.equal(yield* mode("mid"), "on");
    yield* nesting.update({
      commandId: CommandId.make("opt-out"),
      threadId: id("mid"),
      subproject: "off",
    });
    yield* nest("worker", "mid", "nest-worker");
    assert.equal(yield* mode("mid"), "off");
  }).pipe(Effect.provide(nativeLayer)),
);

it.effect(
  "legacy mode imports once beside parents, scope and lifecycle; explicit V2 mode wins",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE effect_sql_fork_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
      yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name) VALUES (16, 'ProjectionThreadsSubproject')`;
      assert.deepEqual(yield* runForkMigrations(), []);
      const ledger = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, parent_thread_id TEXT, scope TEXT, settle_on_complete INTEGER, subproject TEXT)`;
      yield* sql`INSERT INTO projection_threads VALUES ('mid', 'top', 'charter', 1, 'on'), ('worker', 'mid', NULL, NULL, 'off')`;
      yield* initializeMetadata(sql);
      assert.deepEqual(
        (yield* listMetadata(sql)).find((row) => row.threadId === id("mid")),
        {
          threadId: id("mid"),
          parentThreadId: id("top"),
          scope: "charter",
          settleOnComplete: true,
          subproject: "on",
        },
      );
      const before = yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`;
      yield* writeMetadata(sql, {
        threadId: id("mid"),
        parentThreadId: id("top"),
        scope: "v2 charter",
        subproject: "auto",
      });
      yield* initializeMetadata(sql);
      assert.equal(
        (yield* listMetadata(sql)).find((row) => row.threadId === id("mid"))?.subproject,
        "auto",
      );
      assert.equal(
        (yield* listMetadata(sql)).find((row) => row.threadId === id("mid"))?.scope,
        "v2 charter",
      );
      assert.deepEqual(yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`, before);
      assert.deepEqual(yield* runForkMigrations(), []);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
        ledger,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
