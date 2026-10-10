import { describe } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as Policy from "../fork/recovery/StartupResumePolicy.ts";
import { runOrderedV2StartupPhases } from "../serverRuntimeStartup.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape, ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(PlatformTestLayer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");
const started: string[] = [];
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return {
        instanceId: modelSelection.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? "/tmp",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.never,
        ensureThread: (thread) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider-thread:${thread.threadId}`),
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: thread.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: `native:${thread.threadId}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turn) =>
          Effect.sync(() => {
            started.push(turn.message.text);
          }),
        interruptTurn: () => Effect.void,
        steerTurn: () => Effect.die("unused steering"),
        respondToRuntimeRequest: () => Effect.die("unused runtime request"),
        readThreadSnapshot: () => Effect.die("unused snapshot"),
        rollbackThread: () => Effect.die("unused rollback"),
        forkThread: () => Effect.die("unused fork"),
      } satisfies ProviderAdapterV2SessionRuntime;
    }),
} satisfies ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const TestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProviderContinuationRequests.layer,
  IdAllocator.layer,
).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(PlatformTestLayer),
);

const seedCompletions = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const { threadId, projectId, runId, rootNodeId, taskId, now } = input;
    const providerThreadId = ProviderThreadId.make("provider-thread:sandbox-parent");
    const childThreadId = ThreadId.make("thread:sandbox-terminal-child");
    const childRunId = RunId.make("run:sandbox-terminal-child");
    const childTaskId = NodeId.make("node:sandbox-terminal-child");
    yield* projects.create({
      commandId: CommandId.make("command:seed-project"),
      projectId,
      title: "Sandbox completion",
      workspaceRoot: yield* checkpointWorkspace("sandbox-continuation"),
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:seed-parent"),
      threadId,
      projectId,
      title: "Sandbox completion",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* orchestrator.getThreadProjection(threadId);
    const run = (id: RunId, owner: ThreadId) =>
      ({
        id,
        threadId: owner,
        ordinal: 1,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${id}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      }) satisfies OrchestrationV2Run;
    const task = {
      id: taskId,
      threadId,
      runId,
      parentNodeId: rootNodeId,
      origin: "app_owned" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId: modelSelection.instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Background work",
      title: null,
      model: null,
      completionWake: "always" as const,
      completionDelivery: { state: "claimed" as const, observedByRunId: null },
      status: "completed" as const,
      result: "child finished",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    // These persisted terminal rows predate startup. The real terminal reactor
    // skips runtime-reconcile commands, so only ordered startup offers the wake.
    yield* sink.write({
      commandId: CommandId.make("command:runtime-reconcile:seed-completions"),
      events: [
        {
          id: EventId.make("event:seed-provider-thread"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: "native:sandbox-parent", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("event:seed-parent-run"),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            ...run(runId, threadId),
            rootNodeId,
            providerThreadId,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery: {
                generation: 1,
                messageId: MessageId.make("message:delegated-delivery"),
                taskIds: [taskId],
              },
            },
          },
        },
        {
          id: EventId.make("event:seed-task"),
          type: "subagent.updated",
          threadId,
          runId,
          nodeId: taskId,
          occurredAt: now,
          payload: task,
        },
        {
          id: EventId.make("event:seed-child-thread"),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...parent.thread,
            id: childThreadId,
            createdBy: "agent",
            creationSource: "server",
            lineage: {
              parentThreadId: threadId,
              relationshipToParent: "subagent",
              rootThreadId: threadId,
            },
            forkedFrom: { type: "node", nodeId: childTaskId },
          },
        },
        {
          id: EventId.make("event:seed-child-task"),
          type: "subagent.updated",
          threadId,
          runId,
          nodeId: childTaskId,
          occurredAt: now,
          payload: {
            ...task,
            id: childTaskId,
            childThreadId,
            status: "running",
            result: null,
            completedAt: null,
            completionDelivery: undefined,
          },
        },
        {
          id: EventId.make("event:seed-child-result"),
          type: "message.updated",
          threadId: childThreadId,
          runId: childRunId,
          occurredAt: now,
          payload: {
            id: MessageId.make("message:child-result"),
            threadId: childThreadId,
            runId: childRunId,
            nodeId: null,
            role: "assistant",
            text: "durable child result",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "server",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("event:seed-child-run"),
          type: "run.updated",
          threadId: childThreadId,
          runId: childRunId,
          occurredAt: now,
          payload: run(childRunId, childThreadId),
        },
      ],
    });
    return { taskId: childTaskId, childThreadId, childRunId };
  });

describe.each([undefined, "0", "1", "invalid"])(
  "persisted continuation startup flag=%s",
  (disabled) => {
    it.effect(
      "withholds automatic completion offers after ready while retaining results and allowing explicit sends",
      () =>
        Effect.gen(function* () {
          started.length = 0;
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const policy = yield* Policy.StartupResumePolicy;
            const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
            const now = yield* DateTime.now;
            const threadId = ThreadId.make("thread:sandbox-completion-parent");
            const projectId = ProjectId.make("project:sandbox-completion");
            const runId = RunId.make("run:sandbox-completion-parent");
            const rootNodeId = NodeId.make("node:sandbox-completion-root");
            const taskId = NodeId.make("node:sandbox-persisted-result");
            const child = yield* seedCompletions({
              threadId,
              projectId,
              runId,
              rootNodeId,
              taskId,
              now,
            });
            const before = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(before.providerSessions, []);
            assert.deepEqual(before.providerTurns, []);
            const sql = yield* SqlClient.SqlClient;
            for (const table of [
              "provider_session_runtime",
              "orchestration_v2_projection_provider_session_bindings",
              "orchestration_v2_effect_outbox",
            ]) {
              const rows = yield* sql.unsafe<{ count: number }>(
                `SELECT COUNT(*) AS count FROM ${table}`,
              );
              assert.equal(rows[0]?.count, 0, `${table} must be empty before startup`);
            }
            assert.equal(yield* worker.drain(), 0);
            yield* runOrderedV2StartupPhases({
              importLegacyShells: Effect.void,
              recover: recovery.recover,
              recoverDelegatedTasks: orchestrator.recoverDelegatedTasks,
              // Delay continuation delivery until ready; drain startup effects normally.
              startEffectWorker: worker.drain().pipe(Effect.asVoid),
              autoBootstrap: Effect.void,
            });
            yield* policy.markCommandReady;
            yield* TestClock.adjust("1 millis");

            // An archived-thread offer is a FIFO worker receipt: it is cleared only
            // after all preceding offers have finished dispatch (or been withheld).
            const archived = ThreadId.make("thread:continuation-drain-receipt");
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("command:receipt-thread"),
              threadId: archived,
              projectId,
              title: "Drain receipt",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("command:receipt-archive"),
              threadId: archived,
            });
            const drainContinuations = Effect.gen(function* () {
              const cleared = yield* Deferred.make<void>();
              yield* requests.offer({
                threadId: archived,
                providerThreadId: ProviderThreadId.make("receipt-provider-thread"),
                driver,
                detail: null,
                clearIfCurrent: () => Deferred.succeed(cleared, undefined).pipe(Effect.asVoid),
              });
              yield* Deferred.await(cleared);
              yield* worker.drain();
            });
            const continuation = ProviderContinuationService.workerLive.pipe(
              Layer.provide(
                Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, requests),
              ),
              Layer.provide(
                Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
              ),
              Layer.provide(IdAllocator.layer),
            );
            yield* Effect.gen(function* () {
              yield* drainContinuations;
              // Repeat recovery to cover durable re-offers and chained child settlement.
              yield* orchestrator.recoverDelegatedTasks;
              yield* drainContinuations;
              yield* TestClock.adjust("10 seconds");
              yield* drainContinuations;
              const blocked = disabled === "1" || disabled === "invalid";
              assert.equal(started.length, blocked ? 0 : 1);
              const after = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(
                after.subagents.find((task) => task.id === taskId)?.result,
                "child finished",
              );
              assert.equal(
                after.subagents.find((task) => task.id === child.taskId)?.result,
                "durable child result",
              );
              assert.equal(
                after.subagents.find((task) => task.id === child.taskId)?.status,
                "completed",
              );
              if (blocked) {
                assert.equal(after.messages.length, 0);
                assert.deepEqual(after.runs[0]?.delegatedCompletion?.delivery?.taskIds, [
                  taskId,
                  child.taskId,
                ]);
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make("command:explicit-user"),
                  threadId,
                  messageId: MessageId.make("message:explicit-user"),
                  text: "Explicit user send",
                  attachments: [],
                  dispatchMode: { type: "start_immediately" },
                  createdBy: "user",
                  creationSource: "web",
                });
                yield* worker.drain();
                assert.deepEqual(started, ["Explicit user send"]);
              } else {
                assert.equal(after.messages.length, 1);
                assert.equal(after.messages[0]?.creationSource, "server");
                assert.equal(
                  started[0],
                  `Delegated tasks ${taskId}, ${child.taskId} reached terminal states. Use task_status with each taskId to read the results.`,
                );
              }
            }).pipe(Effect.provide(continuation), Effect.scoped);
          }).pipe(
            Effect.provide(
              TestLayer.pipe(
                Layer.provideMerge(
                  ConfigProvider.layer(
                    ConfigProvider.fromEnv({
                      env:
                        disabled === undefined ? {} : { T3CODE_DISABLE_STARTUP_RESUME: disabled },
                    }),
                  ),
                ),
              ),
            ),
            Effect.scoped,
          );
        }),
    );
  },
);
