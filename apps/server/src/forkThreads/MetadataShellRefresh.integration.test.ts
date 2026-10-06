import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeNestingService } from "./NestingService.ts";

const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-metadata-shell-refresh" },
  ProviderAdapterRegistry.makeLayer([]),
  { databaseLayer: database, runEffectWorker: false },
);
const layer = Layer.merge(
  ThreadManagement.layer.pipe(Layer.provide(runtime)),
  EventStore.layer,
).pipe(Layer.provideMerge(database));

it.effect(
  "metadata updates publish one native shell event after commit and recover refresh on retry",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const management = yield* ThreadManagement.ThreadManagementService;
      const events = yield* EventStore.EventStoreV2;
      const parentId = ThreadId.make("refresh-parent");
      const threadId = ThreadId.make("refresh-child");
      for (const id of [parentId, threadId]) {
        yield* management.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: id,
          projectId: ProjectId.make("refresh-project"),
          title: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      const before = (yield* management.getThreadShell(threadId))!;
      const input = {
        commandId: CommandId.make("nest-refresh"),
        threadId,
        parentThreadId: parentId,
      };
      const interrupted = yield* makeNestingService(sql, management.getThreadShell, () =>
        Effect.fail("refresh interrupted"),
      );
      assert.equal((yield* Effect.exit(interrupted.update(input)))._tag, "Failure");
      assert.equal(
        (yield* interrupted.list()).find((row) => row.threadId === threadId)?.parentThreadId,
        parentId,
      );
      const refreshId = CommandId.make("nest-refresh:shell-refresh");
      assert.equal(
        (yield* Stream.runCollect(events.readByCommandId({ commandId: refreshId }))).length,
        0,
      );
      const service = yield* makeNestingService(
        sql,
        management.getThreadShell,
        management.dispatch,
      );
      assert.equal((yield* service.update(input)).parentThreadId, parentId);
      yield* service.update(input);
      const refreshed = yield* Stream.runCollect(events.readByCommandId({ commandId: refreshId }));
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0]?.event.type, "thread.metadata-updated");
      const after = (yield* management.getThreadShell(threadId))!;
      assert.deepStrictEqual(after.lineage, before.lineage);
      assert.equal(after.projectId, before.projectId);
      assert.equal(after.worktreePath, before.worktreePath);
      assert.deepStrictEqual(after.modelSelection, before.modelSelection);
      const unnest = {
        ...input,
        commandId: CommandId.make("unnest-refresh"),
        parentThreadId: null,
      };
      yield* service.update(unnest);
      yield* service.update(input); // replaying an older receipt must not restore the parent or emit again
      assert.equal(
        (yield* service.list()).find((row) => row.threadId === threadId)?.parentThreadId,
        null,
      );
      assert.equal(
        (yield* Stream.runCollect(events.readByCommandId({ commandId: refreshId }))).length,
        1,
      );
      assert.equal(
        (yield* Stream.runCollect(
          events.readByCommandId({ commandId: CommandId.make("unnest-refresh:shell-refresh") }),
        )).length,
        1,
      );
      const invalid = {
        ...input,
        commandId: CommandId.make("invalid-refresh"),
        parentThreadId: threadId,
      };
      assert.equal((yield* Effect.exit(service.update(invalid)))._tag, "Failure");
      assert.equal(
        (yield* Stream.runCollect(
          events.readByCommandId({ commandId: CommandId.make("invalid-refresh:shell-refresh") }),
        )).length,
        0,
      );
    }).pipe(Effect.provide(layer)),
);
