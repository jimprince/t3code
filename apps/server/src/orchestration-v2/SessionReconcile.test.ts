import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeSessionReconcileService } from "../forkThreads/SessionReconcileService.ts";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const recoveryLayer = ProviderRuntimeRecovery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EventSink.layer.pipe(
        Layer.provide(
          Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
            Layer.provideMerge(database),
          ),
        ),
      ),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      IdAllocator.layer,
      ServerSettings.layerTest(),
      Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
        runRecoveryOnce: Effect.succeed(false),
      }),
    ),
  ),
);

const reconcileScenario = (
  status: "running" | "interrupted" | "completed" | "failed",
  duringGrace?: "completed" | "failed" | "interrupted" | "newer" | "attempt" | "ordinal",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: ProviderSessionId.make("session:settle-binding"),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("session:settle-binding"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderSessionId.make("session:settle-binding"),
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "running",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: status === "failed" ? "Provider crashed." : null,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: status,
          requestedAt: now,
          startedAt: now,
          completedAt: status === "running" ? null : now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:node:${ordinal}`),
        type: "node.updated",
        threadId,
        runId,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "root_turn",
          status,
          countsForRun: true,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: CheckpointScopeId.make("scope:settle-binding"),
          startedAt: now,
          completedAt: status === "running" ? null : now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: status,
          startedAt: now,
          completedAt: status === "running" ? null : now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: status,
          startedAt: now,
          completedAt: status === "running" ? null : now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make(`stop:${status}`),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    if (status === "running") {
      const runId = RunId.make("run:settle-binding:1");
      yield* projections.apply({
        id: EventId.make("interrupt-request"),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("interrupt-request"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId,
          providerTurnId: settle.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 12,
          status: "completed",
          title: "Interrupt requested",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "run_interrupt_request",
          message: "Stop",
        },
      });
    }
    const reconcile = makeSessionReconcileService({
      getThreadRecords: orchestrator.getThreadRecords,
      dispatch: orchestrator.dispatch,
    });
    if (status === "running") {
      assert.equal(
        (yield* Effect.exit(
          reconcile.reconcile({ commandId: CommandId.make("refuse-live"), threadId }),
        ))._tag,
        "Failure",
      );
      // No native terminal arrives: ACK is durable but cannot end the run.
      yield* orchestrator.dispatch({ ...settle, interruptAcknowledged: true });
      const acknowledged = yield* projections.getThreadProjection(threadId);
      assert.equal(acknowledged.runs[0]?.status, "running");
      assert.equal(acknowledged.providerSessions[0]?.status, "running");
      assert.equal(
        acknowledged.turnItems.find((item) => item.type === "run_interrupt_request")?.title,
        "Stop acknowledged",
      );
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const claim = { workerId: "fallback-test", leaseDurationMs: 30_000 };
      assert.isTrue(Option.isNone(yield* outbox.claimNext(claim)));
      // A delayed fallback has its own lane and cannot block native checkpoints.
      yield* outbox.enqueue([
        {
          id: "native-checkpoint-during-grace",
          commandId: CommandId.make("native-checkpoint-during-grace"),
          threadId,
          request: {
            type: "checkpoint.capture",
            runId: RunId.make("run:settle-binding:1"),
            scopeId: CheckpointScopeId.make("scope:settle-binding"),
          },
        },
      ]);
      const checkpoint = Option.getOrThrow(yield* outbox.claimNext(claim));
      assert.equal(checkpoint.request.type, "checkpoint.capture");
      yield* outbox.succeed({ effectId: checkpoint.id, workerId: claim.workerId });
      if (duringGrace && ["completed", "failed", "interrupted"].includes(duringGrace)) {
        yield* projections.apply({
          id: EventId.make("native-terminal-during-grace"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...acknowledged.providerTurns[0]!,
            status: duringGrace as "completed" | "failed" | "interrupted",
            completedAt: now,
          },
        });
      }
      if (duringGrace && ["completed", "failed", "interrupted"].includes(duringGrace)) {
        yield* projections.apply({
          id: EventId.make("native-attempt-during-grace"),
          type: "run-attempt.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...acknowledged.attempts[0]!,
            status: duringGrace as "completed" | "failed" | "interrupted",
            completedAt: now,
          },
        });
        yield* projections.apply({
          id: EventId.make("native-session-during-grace"),
          type: "provider-session.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...acknowledged.providerSessions[0]!,
            status: "ready",
            lastError: "native marker",
          },
        });
      }
      if (duringGrace === "attempt") {
        yield* projections.apply({
          id: EventId.make("retry-during-grace"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...acknowledged.runs[0]!, activeAttemptId: RunAttemptId.make("new-attempt") },
        });
        const newItemId = TurnItemId.make("new-attempt-background-work");
        const oldItem = acknowledged.turnItems.find((item) => item.type === "command_execution")!;
        yield* projections.apply({
          id: EventId.make("new-attempt-background-work"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: { ...oldItem, id: newItemId, status: "running", completedAt: null },
        });
        // A late old ACK must not settle background work belonging to a retry.
        yield* orchestrator.dispatch({
          ...settle,
          commandId: CommandId.make("late-old-ack-during-retry"),
          interruptAcknowledged: true,
        });
        assert.equal(
          (yield* projections.getThreadProjection(threadId)).turnItems.find(
            (item) => item.id === newItemId,
          )?.status,
          "running",
        );
      }
      if (duringGrace === "ordinal") {
        yield* projections.apply({
          id: EventId.make("new-owner-during-grace"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: { ...acknowledged.providerThreads[0]!, lastRunOrdinal: 2 },
        });
      }
      if (duringGrace === "newer") {
        yield* projections.apply({
          id: EventId.make("newer-during-grace"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: { ...acknowledged.runs[0]!, id: RunId.make("newer-during-grace"), ordinal: 2 },
        });
      }
      yield* TestClock.adjust("9999 millis");
      assert.isTrue(Option.isNone(yield* outbox.claimNext(claim)));
      yield* TestClock.adjust("1 millis");
      const fallback = Option.getOrThrow(yield* outbox.claimNext(claim));
      assert.equal(fallback.request.type, "provider-turn.interrupt-settle");
      // Exercise the durable recovery path and the production executor branch.
      assert.equal((yield* outbox.reconcileAfterProcessLoss).requeued, 1);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      assert.isTrue(yield* worker.runOnce);
      if (duringGrace) {
        const preserved = yield* projections.getThreadProjection(threadId);
        assert.equal(preserved.runs[0]?.status, "running");
        const native = ["completed", "failed", "interrupted"].includes(duringGrace);
        assert.equal(preserved.providerSessions[0]?.status, native ? "ready" : "running");
        if (native) {
          assert.equal(preserved.providerTurns[0]?.status, duringGrace);
          assert.equal(preserved.attempts[0]?.status, duringGrace);
          assert.equal(preserved.providerSessions[0]?.lastError, "native marker");
        }
        if (duringGrace === "newer") assert.equal(preserved.runs[1]?.status, "running");
        if (duringGrace === "attempt") {
          assert.equal(
            preserved.turnItems.find(
              (item) => item.id === TurnItemId.make("new-attempt-background-work"),
            )?.status,
            "running",
          );
        }
        return;
      }
    } else {
      yield* reconcile.reconcile({ commandId: settle.commandId, threadId });
    }
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.providerSessions[0]?.status, status === "failed" ? "error" : "ready");
    assert.equal(projection.runs[0]?.status, status === "running" ? "interrupted" : status);
    if (status === "failed")
      assert.equal(projection.providerSessions[0]?.lastError, "Provider crashed.");
    if (status === "running") {
      assert.equal(projection.nodes[0]?.status, "interrupted");
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const checkpointEffects = yield* outbox.listByCommandId(
        CommandId.make("command:effect:checkpoint.capture:run:settle-binding:1"),
      );
      assert.equal(checkpointEffects.length, 1);
      assert.deepEqual(checkpointEffects[0]?.request, {
        type: "checkpoint.capture",
        runId: RunId.make("run:settle-binding:1"),
        scopeId: CheckpointScopeId.make("scope:settle-binding"),
      });
    }
    const replay = yield* orchestrator.dispatch(settle);
    assert.isAtLeast(replay.sequence, 1);
    assert.equal(
      (yield* Effect.exit(
        reconcile.reconcile({ commandId: CommandId.make("refuse-idle"), threadId }),
      ))._tag,
      "Failure",
    );
    assert.equal(
      (yield* projections.getThreadProjection(threadId)).providerSessions[0]?.status,
      status === "failed" ? "error" : "ready",
    );
    // Simulate the stale runtime row persisted before a crash. Real startup recovery writes
    // the stopped session through the event store and is idempotent on the same database.
    yield* projections.apply({
      id: EventId.make("crash-stale-session"),
      type: "provider-session.updated",
      threadId,
      occurredAt: now,
      payload: { ...projection.providerSessions[0]!, status: "running" },
    });
    yield* Effect.gen(function* () {
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      assert.equal((yield* recovery.reconcile("startup")).stoppedSessions, 1);
      assert.equal(
        (yield* projections.getThreadProjection(threadId)).providerSessions[0]?.status,
        "stopped",
      );
      assert.equal((yield* recovery.reconcile("startup")).stoppedSessions, 0);
    }).pipe(Effect.provide(recoveryLayer));
    const newerRun = {
      ...projection.runs[0]!,
      id: RunId.make("run:newer"),
      ordinal: 2,
      status: "running" as const,
      completedAt: null,
    };
    yield* projections.apply({
      id: EventId.make("newer-run"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: newerRun,
    });
    yield* projections.apply({
      id: EventId.make("newer-session"),
      type: "provider-session.updated",
      threadId,
      occurredAt: now,
      payload: { ...projection.providerSessions[0]!, status: "running" },
    });
    yield* orchestrator.dispatch({ ...settle, commandId: CommandId.make("late-ack") });
    assert.equal(
      (yield* projections.getThreadProjection(threadId)).providerSessions[0]?.status,
      "running",
    );
    assert.equal(
      (yield* Effect.exit(
        reconcile.reconcile({ commandId: CommandId.make("refuse-newer"), threadId }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer));

it.effect.each(["interrupted", "completed", "failed"] as const)(
  "reconciles an ended %s run and replays safely",
  reconcileScenario,
);

it.effect("native terminal never arrives: fallback settles after the ten-second grace", () =>
  reconcileScenario("running"),
);

it.effect.each(["completed", "failed", "interrupted"] as const)(
  "fallback preserves native %s while its checkpoint is pending",
  (status) => reconcileScenario("running", status),
);

it.effect("newer work started during the grace wins over the delayed fallback", () =>
  reconcileScenario("running", "newer"),
);

it.effect.each(["attempt", "ordinal"] as const)(
  "fallback preserves newer %s ownership during the grace",
  (ownership) => reconcileScenario("running", ownership),
);
