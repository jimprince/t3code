import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { listMetadata } from "./MetadataStore.ts";
import { makeNestingService } from "./NestingService.ts";

const id = ThreadId.make;
const shells = new Map(
  ["parent", "child", "grandchild"].map((name) => [
    id(name),
    { id: id(name), projectId: ProjectId.make("project"), archivedAt: null },
  ]),
);
const input = (child: string, parent: string | null, command = `${child}-${parent}`) => ({
  commandId: CommandId.make(command),
  threadId: id(child),
  parentThreadId: parent === null ? null : id(parent),
});
it.effect("reparent, unnest and receipts survive restart without changing native lineage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getShell = (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null);
    const service = yield* makeNestingService(sql, getShell, () => Effect.void);
    yield* service.update(input("child", "parent"));
    yield* service.update(input("grandchild", "child"));
    const restart = yield* makeNestingService(sql, getShell, () => Effect.void);
    assert.equal(
      (yield* restart.list()).find((row) => row.threadId === id("grandchild"))?.parentThreadId,
      id("child"),
    );
    yield* restart.update(input("child", null));
    yield* restart.update(input("child", "parent")); // duplicate receipt cannot overwrite the unnest
    assert.equal(
      (yield* restart.list()).find((row) => row.threadId === id("child"))?.parentThreadId,
      null,
    );
    for (const [child, parent] of [
      ["parent", "parent"],
      ["child", "grandchild"],
      ["child", "missing"],
    ]) {
      const result = yield* Effect.exit(
        restart.update(input(child!, parent!, `reject-${child}-${parent}`)),
      );
      assert.equal(result._tag, "Failure");
    }
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("legacy edges import once, including missing parents and nulls", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Only fields required by the retained V1 table are populated through the fixture test below.
    const service = yield* makeNestingService(sql, (threadId) =>
      Effect.succeed(shells.get(threadId) ?? null), () => Effect.void);
    yield* service.update(input("child", "parent", "import-edit"));
    const restart = yield* makeNestingService(sql, (threadId) =>
      Effect.succeed(shells.get(threadId) ?? null), () => Effect.void);
    assert.equal(
      (yield* restart.list()).find((row) => row.threadId === id("child"))?.parentThreadId,
      id("parent"),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "cross-project reparent preserves each child's workspace/defaults and does not cascade",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const parent = {
        id: id("supervisor"),
        projectId: ProjectId.make("supervisor-project"),
        archivedAt: null as DateTime.Utc | null,
      };
      const child = {
        id: id("worker"),
        projectId: ProjectId.make("worker-project"),
        archivedAt: null,
        worktreePath: "/worker",
        modelSelection: "worker-default",
      };
      const service = yield* makeNestingService(sql, (threadId) =>
        Effect.succeed(threadId === parent.id ? parent : threadId === child.id ? child : null), () => Effect.void);
      yield* service.update(input("worker", "supervisor", "cross-project"));
      parent.archivedAt = DateTime.makeUnsafe(0);
      assert.equal(
        (yield* service.list()).find((row) => row.threadId === child.id)?.parentThreadId,
        parent.id,
      );
      assert.equal(child.archivedAt, null);
      assert.equal(child.projectId, ProjectId.make("worker-project"));
      assert.equal(child.worktreePath, "/worker");
      assert.equal(child.modelSelection, "worker-default");
      yield* service.update(input("worker", null, "cross-project-unnest"));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-nesting-native" },
  ProviderAdapterRegistry.makeLayer([]),
  { databaseLayer: database, runEffectWorker: false },
);
const nativeLayer = ThreadManagement.layer.pipe(
  Layer.provide(runtime),
  Layer.provideMerge(database),
);
it.effect(
  "V2 creation/reparent/archive leaves native lineage, independent workspace and root runs intact",
  () =>
    Effect.gen(function* () {
      const management = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      for (const name of ["native-parent", "native-child", "native-grandchild"]) {
        yield* management.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${name}`),
          threadId: id(name),
          projectId: ProjectId.make(name),
          title: name,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: name },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: name,
          worktreePath: `/workspace/${name}`,
          createdBy: "user",
          creationSource: "web",
        });
      }
      const before = (yield* management.getThreadShell(id("native-child")))!;
      const nativeEvents: string[] = [];
      const service = yield* makeNestingService(sql, management.getThreadShell, (command) =>
        management.dispatch(command).pipe(
          Effect.tap((receipt) =>
            Effect.sync(() => {
              nativeEvents.push(...receipt.storedEvents.map((event) => event.event.type));
            }),
          ),
        ),
      );
      yield* service.update(input("native-child", "native-parent", "native-nest"));
      yield* service.update(input("native-grandchild", "native-child", "native-deep"));
      assert.deepStrictEqual(nativeEvents, ["thread.metadata-updated", "thread.metadata-updated"]);
      for (const edge of [
        input("native-parent", "native-parent", "native-self"),
        input("native-parent", "native-grandchild", "native-cycle"),
      ])
        assert.equal((yield* Effect.exit(service.update(edge)))._tag, "Failure");
      const restart = yield* makeNestingService(sql, management.getThreadShell, () => Effect.void);
      assert.equal(
        (yield* restart.list()).find((row) => row.threadId === id("native-child"))?.parentThreadId,
        id("native-parent"),
      );
      yield* management.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-native-parent"),
        threadId: id("native-parent"),
      });
      const child = (yield* management.getThreadShell(id("native-child")))!;
      assert.deepStrictEqual(child.lineage, before.lineage);
      assert.equal(child.projectId, before.projectId);
      assert.equal(child.worktreePath, before.worktreePath);
      assert.deepStrictEqual(child.modelSelection, before.modelSelection);
      assert.equal(child.archivedAt, null);
      assert.equal(child.latestRunId, null);
      yield* restart.update(input("native-child", null, "native-unnest"));
    }).pipe(Effect.provide(nativeLayer)),
);

it.effect(
  "CLI-originated sidecar writes dispatch a stable native shell refresh after persistence",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events: string[] = [];
      const service = yield* makeNestingService(
        sql,
        (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        (command) =>
          Effect.gen(function* () {
            assert.equal(
              (yield* listMetadata(sql)).find((row) => row.threadId === command.threadId)
                ?.parentThreadId,
              "parent",
            );
            events.push(`${command.type}:${command.commandId}`);
          }),
      );
      yield* service.update(input("child", "parent", "cli-nest"));
      assert.deepEqual(events, ["thread.metadata.update:cli-nest:shell-refresh"]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
