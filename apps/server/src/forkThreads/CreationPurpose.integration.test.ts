import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { readMetadata, writeMetadata } from "./MetadataStore.ts";
import { resolveCreatorPurpose } from "./ThreadPurpose.ts";

const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "creation-purpose" },
  Registry.makeLayer([]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);
const layer = Layer.mergeAll(runtime, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
it.effect(
  "one complete seed preserves delegate ownership, dynamic inherited purpose and root overrides",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const owner = ThreadId.make("purpose-owner");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("purpose-owner"),
        threadId: owner,
        projectId: ProjectId.make("purpose-project"),
        title: "Owner",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        purposeSeed: "harness",
      });
      const parent = yield* store.getThread(owner);
      const childId = ThreadId.make("purpose-child");
      const child = {
        ...parent,
        id: childId,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        lineage: {
          parentThreadId: owner,
          rootThreadId: owner,
          relationshipToParent: "subagent" as const,
        },
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("purpose-child"),
            type: "thread.created",
            threadId: childId,
            occurredAt: now,
            purposeSeed: "project",
            payload: child,
          },
        ],
      });
      assert.equal((yield* readMetadata(sql, childId))?.parentThreadId, owner);
      assert.equal((yield* readMetadata(sql, childId))?.purpose, undefined);
      assert.equal(yield* resolveCreatorPurpose(sql, childId, store.getThreadShell), "harness");
      yield* writeMetadata(sql, { threadId: owner, parentThreadId: null, purpose: "project" });
      assert.equal(yield* resolveCreatorPurpose(sql, childId, store.getThreadShell), "project");
      const explicit = {
        threadId: childId,
        parentThreadId: null,
        purpose: "harness" as const,
        settleOnComplete: false,
      };
      yield* writeMetadata(sql, explicit);
      yield* sink.write({
        events: [
          {
            id: EventId.make("purpose-child-replay"),
            type: "thread.created",
            threadId: childId,
            occurredAt: now,
            purposeSeed: "project",
            payload: child,
          },
        ],
      });
      assert.deepEqual(yield* readMetadata(sql, childId), explicit);
      const rootId = ThreadId.make("purpose-new-root");
      const root = {
        ...parent,
        id: rootId,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        lineage: { parentThreadId: null, rootThreadId: rootId, relationshipToParent: null },
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("purpose-root"),
            type: "thread.created",
            threadId: rootId,
            occurredAt: now,
            purposeSeed: "harness",
            payload: root,
          },
        ],
      });
      assert.deepEqual(yield* readMetadata(sql, rootId), {
        threadId: rootId,
        parentThreadId: null,
        purpose: "harness",
      });
    }).pipe(Effect.provide(layer)),
);
