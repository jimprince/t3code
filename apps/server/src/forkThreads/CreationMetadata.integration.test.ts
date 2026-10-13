import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { readMetadata, writeMetadata } from "./MetadataStore.ts";

const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "creation-metadata" },
  Registry.makeLayer([]),
  { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
);
const layer = Layer.mergeAll(runtime, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
it.effect(
  "seeds a delegate before its separately persisted task and preserves explicit metadata on replay",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const parentId = ThreadId.make("creation-owner");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-owner"),
        threadId: parentId,
        projectId: ProjectId.make("creation-project"),
        title: "Owner",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const parent = yield* store.getThread(parentId);
      const childId = ThreadId.make("creation-child");
      const child = {
        ...parent,
        id: childId,
        title: "Child",
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        lineage: {
          parentThreadId: parentId,
          rootThreadId: parentId,
          relationshipToParent: "subagent" as const,
        },
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("child-create"),
            type: "thread.created",
            threadId: childId,
            occurredAt: now,
            payload: child,
          },
        ],
      });
      assert.deepEqual(yield* readMetadata(sql, childId), {
        threadId: childId,
        parentThreadId: parentId,
        remoteParent: null,
        subproject: "off",
        settleOnComplete: true,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("child-task"),
            type: "subagent.updated",
            threadId: parentId,
            occurredAt: now,
            payload: {
              id: NodeId.make("child-task"),
              threadId: parentId,
              runId: null,
              parentNodeId: NodeId.make("owner-node"),
              origin: "app_owned",
              createdBy: "agent",
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: parent.providerInstanceId,
              providerThreadId: null,
              childThreadId: childId,
              nativeTaskRef: null,
              prompt: "Work",
              title: "Child",
              model: "model",
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          },
        ],
      });
      assert.equal((yield* readMetadata(sql, childId))?.parentThreadId, parentId);
      for (const remoteParent of [
        null,
        { environmentId: "remote-env", threadId: ThreadId.make("remote-owner") },
      ]) {
        const explicit = {
          threadId: childId,
          parentThreadId: null,
          remoteParent,
          subproject: "on" as const,
          settleOnComplete: false,
        };
        yield* writeMetadata(sql, explicit);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`replay-${remoteParent === null ? "unnest" : "remote"}`),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: child,
            },
          ],
        });
        assert.deepEqual(yield* readMetadata(sql, childId), explicit);
      }
      assert.equal(yield* readMetadata(sql, parentId), undefined);
      const nativeId = ThreadId.make("creation-native");
      yield* sink.write({
        events: [
          {
            id: EventId.make("native-create"),
            type: "thread.created",
            threadId: nativeId,
            occurredAt: now,
            payload: { ...child, id: nativeId, creationSource: "provider" },
          },
        ],
      });
      assert.equal(yield* readMetadata(sql, nativeId), undefined);
    }).pipe(Effect.provide(layer)),
);
