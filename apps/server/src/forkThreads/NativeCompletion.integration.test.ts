import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  RunId,
  MessageId,
  RuntimeRequestId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkerLifecycle from "./WorkerLifecycle.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readMetadata, writeMetadata } from "./MetadataStore.ts";
import { nativeEvidence } from "./NativeCompletion.ts";

const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "native-completion" },
  Registry.makeLayer([]),
  { databaseLayer: database, runEffectWorker: false },
);
const layer = WorkerLifecycle.layer.pipe(
  Layer.provideMerge(ThreadManagement.layer),
  Layer.provideMerge(
    Layer.mergeAll(runtime, ProjectionStore.layer).pipe(Layer.provideMerge(database)),
  ),
  Layer.provideMerge(ServerSettings.layerTest({})),
);

it.effect(
  "settles successful runless native children, rejects stale evidence and reopens only automatic settlement",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const lifecycle = yield* WorkerLifecycle.WorkerLifecycle;
      const now = yield* DateTime.now;
      const parentId = ThreadId.make("native-owner");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("owner-create"),
        threadId: parentId,
        projectId: ProjectId.make("native-project"),
        title: "Owner",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const parent = yield* store.getThread(parentId);
      let serial = 0;
      const persist = (task: OrchestrationV2Subagent) =>
        sink.write({
          events: [
            {
              id: EventId.make(`native-task-${serial++}`),
              type: "subagent.updated",
              threadId: parentId,
              occurredAt: task.updatedAt,
              payload: task,
            },
          ],
        });
      const children = new Map<string, OrchestrationV2Subagent>();
      for (const name of [
        "success",
        "failed",
        "cancelled",
        "opt-out",
        "manual",
        "race",
        "unnest",
        "pin",
        "disabled",
        "active",
        "pending",
        "app-failed",
        "app-completed",
        "background",
      ]) {
        const childId = ThreadId.make(`native-${name}`);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`native-create-${name}`),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: {
                ...parent,
                id: childId,
                title: name,
                createdBy: "agent",
                creationSource: "provider",
                lineage: {
                  parentThreadId: parentId,
                  rootThreadId: parentId,
                  relationshipToParent: "subagent",
                },
              },
            },
          ],
        });
        const task: OrchestrationV2Subagent = {
          id: NodeId.make(`task-${name}`),
          threadId: parentId,
          runId: null,
          parentNodeId: NodeId.make("owner-node"),
          origin: "provider_native",
          createdBy: "agent",
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: parent.providerInstanceId,
          providerThreadId: null,
          childThreadId: childId,
          nativeTaskRef: null,
          prompt: "work",
          title: name,
          model: "model",
          status: name === "failed" ? "failed" : name === "cancelled" ? "cancelled" : "completed",
          result: "retained result",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };

        if (name.startsWith("app-"))
          yield* sink.write({
            events: [
              {
                id: EventId.make(`run-${name}`),
                type: "run.updated",
                threadId: childId,
                occurredAt: now,
                payload: {
                  id: RunId.make(`run-${name}`),
                  threadId: childId,
                  ordinal: 1,
                  providerInstanceId: parent.providerInstanceId,
                  modelSelection: parent.modelSelection,
                  providerThreadId: null,
                  userMessageId: MessageId.make(`prompt-${name}`),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: name === "app-failed" ? "failed" : "completed",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: now,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ],
          });
        if (name === "active")
          yield* orchestrator.dispatch({
            type: "thread.unsettle",
            commandId: CommandId.make("active-override"),
            reason: "user",
            threadId: childId,
          });
        if (name === "pending")
          yield* sink.write({
            events: [
              {
                id: EventId.make("pending-request"),
                type: "runtime-request.updated",
                threadId: childId,
                occurredAt: now,
                payload: {
                  id: RuntimeRequestId.make("pending"),
                  nodeId: NodeId.make("pending-node"),
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "message" },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
            ],
          });
        if (name === "background")
          yield* sink.write({
            events: [
              {
                id: EventId.make("native-background"),
                type: "provider-thread.updated",
                threadId: childId,
                occurredAt: now,
                payload: {
                  id: ProviderThreadId.make("child-runtime"),
                  driver: ProviderDriverKind.make("claude"),
                  providerInstanceId: parent.providerInstanceId,
                  providerSessionId: null,
                  appThreadId: childId,
                  ownerNodeId: null,
                  nativeThreadRef: null,
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  pendingBackgroundTasks: [{ taskId: "pending-child", kind: "subagent" }],
                  nativeMetadata: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        children.set(name, task);
        yield* persist(task);
        assert.equal((yield* readMetadata(sql, childId))?.parentThreadId, parentId);
        if (name === "opt-out" || name === "unnest")
          yield* writeMetadata(sql, {
            ...(yield* readMetadata(sql, childId))!,
            ...(name === "opt-out" ? { settleOnComplete: false } : { parentThreadId: null }),
          });
        if (name === "pin")
          yield* orchestrator.dispatch({
            type: "thread.pin",
            commandId: CommandId.make("pin"),
            threadId: childId,
            orderKey: "a0",
          });
        if (name === "disabled")
          yield* orchestrator.dispatch({
            type: "thread.auto-settle.set",
            commandId: CommandId.make("disable"),
            threadId: childId,
            enabled: false,
          });
        if (name === "manual")
          yield* orchestrator.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("manual"),
            threadId: childId,
          });
      }
      const race = children.get("race")!;
      const snapshot = yield* store.getThread(race.childThreadId!);
      const reopenedAt = DateTime.add(now, { seconds: 1 });
      yield* persist({
        ...race,
        status: "running",
        startedAt: reopenedAt,
        completedAt: null,
        updatedAt: reopenedAt,
      });
      const exit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("stale-native"),
          threadId: race.childThreadId!,
          snapshotAt: snapshot.updatedAt,
          nativeCompletion: nativeEvidence(race)!,
        }),
      );
      assert.equal(exit._tag, "Failure");
      yield* lifecycle.drain;
      for (const name of [
        "failed",
        "cancelled",
        "opt-out",
        "race",
        "unnest",
        "pin",
        "disabled",
        "pending",
        "app-failed",
        "background",
      ])
        assert.equal(
          (yield* store.getThread(children.get(name)!.childThreadId!)).settledOverride,
          null,
          name,
        );
      assert.equal(
        (yield* store.getThread(children.get("active")!.childThreadId!)).settledOverride,
        "active",
      );
      assert.equal(
        (yield* store.getThread(children.get("app-completed")!.childThreadId!)).settledOverride,
        "settled",
      );
      const success = children.get("success")!;
      const childId = success.childThreadId!;
      assert.equal((yield* store.getThread(childId)).settledOverride, "settled");
      assert.equal((yield* store.getThreadProjection(childId)).runs.length, 0);
      assert.equal((yield* readMetadata(sql, childId))?.nativeCompletion?.taskId, success.id);
      // New native messages resume the same task through task_started, not app admission.
      yield* persist({
        ...success,
        status: "running",
        startedAt: reopenedAt,
        completedAt: null,
        result: null,
        updatedAt: reopenedAt,
      });
      assert.equal((yield* store.getThread(childId)).settledOverride, null);
      yield* lifecycle.drain;
      assert.equal((yield* store.getThread(childId)).settledOverride, null);
      const done = {
        ...success,
        startedAt: reopenedAt,
        completedAt: DateTime.add(now, { seconds: 2 }),
        updatedAt: DateTime.add(now, { seconds: 2 }),
      };
      yield* persist(done);
      yield* lifecycle.drain;
      assert.equal((yield* store.getThread(childId)).settledOverride, "settled");
      const manual = children.get("manual")!;
      yield* persist({
        ...manual,
        status: "running",
        startedAt: reopenedAt,
        completedAt: null,
        updatedAt: reopenedAt,
      });
      assert.equal((yield* store.getThread(manual.childThreadId!)).settledOverride, "settled");
      // Explicitly settling an already automatically settled child overrides its receipt.
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("manual-after-auto"),
        threadId: childId,
      });
      yield* persist({
        ...done,
        status: "running",
        startedAt: DateTime.add(now, { seconds: 3 }),
        completedAt: null,
        updatedAt: DateTime.add(now, { seconds: 3 }),
      });
      assert.equal((yield* store.getThread(childId)).settledOverride, "settled");
      yield* persist({
        ...race,
        startedAt: reopenedAt,
        completedAt: done.completedAt,
        updatedAt: done.updatedAt,
      });
      const newGeneration = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("stale-completed-generation"),
          threadId: race.childThreadId!,
          snapshotAt: (yield* store.getThread(race.childThreadId!)).updatedAt,
          nativeCompletion: nativeEvidence(race)!,
        }),
      );
      assert.equal(newGeneration._tag, "Failure");
      const beforeCommit = yield* store.getThread(race.childThreadId!);
      const commitRace = yield* Effect.exit(
        sink.write({
          events: [
            {
              id: EventId.make("stale-native-commit"),
              type: "thread.settled",
              threadId: race.childThreadId!,
              occurredAt: done.updatedAt,
              nativeCompletion: nativeEvidence(race)!,
              payload: { ...beforeCommit, settledOverride: "settled", settledAt: done.updatedAt },
            },
          ],
        }),
      );
      assert.equal(commitRace._tag, "Failure");
      yield* lifecycle.drain;
      assert.equal((yield* store.getThread(race.childThreadId!)).settledOverride, "settled");
      const noChild = { ...success, id: NodeId.make("no-child"), childThreadId: null };
      yield* persist(noChild);
      yield* lifecycle.drain;
      assert.equal(
        (yield* store.getShellSnapshot()).threads.some((t) => t.id === ThreadId.make("no-child")),
        false,
      );
    }).pipe(Effect.provide(layer)),
);
