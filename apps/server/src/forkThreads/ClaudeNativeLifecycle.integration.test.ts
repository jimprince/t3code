import { hasLiveChildren } from "./WorkerLifecycleMetadata.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ClaudeAdapter from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import * as WorkerLifecycle from "./WorkerLifecycle.ts";
import { readMetadata } from "./MetadataStore.ts";

// Only the external SDK stream is replaced: adapter, ingestor, sink and lifecycle are real.
const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const frame = (value: unknown) => value as SDKMessage;
it.effect(
  "persists Claude Task output and settles its actual child without manufacturing an app run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-hygiene");
        const messages = yield* Queue.unbounded<SDKMessage>();
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const sessionId = "native-hygiene-session";
        const adapter = ClaudeAdapter.makeClaudeAdapterV2({
          instanceId,
          settings: yield* decodeSettings({}),
          environment: {},
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(sessionId),
            open: () =>
              Effect.succeed({
                messages: Stream.fromQueue(messages),
                offer: () => Effect.void,
                setModel: () => Effect.void,
                setPermissionMode: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const db = SqlitePersistence.layerMemory;
        const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "claude-native-hygiene" },
          Registry.makeSingleLayer(adapter),
          { databaseLayer: db, runEffectWorker: false },
        );
        const layer = WorkerLifecycle.layer.pipe(
          Layer.provideMerge(ThreadManagement.layer),
          Layer.provideMerge(
            Layer.mergeAll(runtime, ProjectionStore.layer).pipe(Layer.provideMerge(db)),
          ),
          Layer.provideMerge(ServerSettings.layerTest({})),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const lifecycle = yield* WorkerLifecycle.WorkerLifecycle;
          const sql = yield* SqlClient.SqlClient;
          const parentId = ThreadId.make("claude-native-owner");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId: parentId,
            projectId: ProjectId.make("native-project"),
            title: "Owner",
            modelSelection: { instanceId, model: "claude-sonnet-4-6" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const watch = (status: "running" | "completed") =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) => event.type === "subagent.updated" && event.payload.status === status,
              ),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start"),
            threadId: parentId,
            messageId: MessageId.make("start"),
            text: "Delegate the work.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const running = yield* watch("running");
          yield* Queue.offer(
            messages,
            frame({
              type: "system",
              subtype: "task_started",
              task_id: "native-task",
              tool_use_id: "native-tool",
              description: "Native work",
              subagent_type: "general-purpose",
              task_type: "local_agent",
              prompt: "Return output",
              uuid: "native-start",
              session_id: sessionId,
            }),
          );
          const runningEvents = yield* Fiber.join(running);
          const taskEvent = runningEvents[0]!;
          if (taskEvent.type !== "subagent.updated" || taskEvent.payload.childThreadId === null)
            return yield* Effect.die("Claude did not create its native conversation");
          const childId = taskEvent.payload.childThreadId;
          assert.equal((yield* readMetadata(sql, childId))?.parentThreadId, parentId);
          assert.isTrue(yield* hasLiveChildren(sql, parentId, store.getThreadShell));
          const completed = yield* watch("completed");
          yield* Queue.offer(
            messages,
            frame({
              type: "user",
              uuid: "native-result",
              session_id: sessionId,
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "native-tool",
                    content: [{ type: "text", text: "Native result retained." }],
                  },
                ],
              },
            }),
          );
          yield* Fiber.join(completed);
          yield* lifecycle.drain;
          const projection = yield* store.getThreadProjection(childId);
          assert.equal(projection.runs.length, 0);
          assert.equal(projection.thread.settledOverride, "settled");
          assert.isFalse(yield* hasLiveChildren(sql, parentId, store.getThreadShell));
          assert.isTrue(
            projection.turnItems.some((item) =>
              JSON.stringify(item).includes("Native result retained."),
            ),
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
);
