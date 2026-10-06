import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initializeMetadata, writeMetadata } from "./MetadataStore.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

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
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

import { archiveDeadline, archiveEligible } from "./ArchiveDeadlines.ts";
import * as WorkerLifecycle from "./WorkerLifecycle.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { completionEligible } from "./WorkerLifecyclePolicy.ts";
it.effect(
  "skips pinned workers, settles after unpin, and preserves opt-out/race guards and retention deadlines",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("worker");
      const now = yield* DateTime.now;
      const sql = yield* SqlClient.SqlClient;
      yield* initializeMetadata(sql);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project"),
        title: "Worker",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const metadata = {
        threadId,
        parentThreadId: ThreadId.make("parent"),
        settleOnComplete: true,
      };
      yield* writeMetadata(sql, metadata);
      const runId = RunId.make("completed");
      yield* store.apply({
        id: EventId.make("completed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("prompt"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("pin"),
        threadId,
        orderKey: "a0",
      });
      const projection = yield* store.getThreadProjection(threadId);
      assert.equal(completionEligible(projection, runId, metadata), false);
      const lifecycle = yield* WorkerLifecycle.WorkerLifecycle;
      yield* lifecycle.drain;
      assert.equal((yield* store.getThreadProjection(threadId)).thread.settledOverride, null);
      yield* orchestrator.dispatch({
        type: "thread.unpin",
        commandId: CommandId.make("unpin"),
        threadId,
      });
      assert.equal(
        completionEligible(
          { ...projection, thread: { ...projection.thread, autoSettleDisabledAt: now } },
          runId,
        ),
        false,
      );
      assert.equal(
        completionEligible(projection, runId, { ...metadata, settleOnComplete: false }),
        false,
      );
      const unpinned = yield* store.getThreadProjection(threadId);
      assert.equal(completionEligible(unpinned, runId, metadata), true);
      assert.equal(
        completionEligible(unpinned, runId, { ...metadata, settleOnComplete: false }),
        false,
      );
      yield* lifecycle.drain;
      yield* lifecycle.drain;

      const settled = yield* store.getThreadProjection(threadId);
      assert.equal(settled.thread.settledOverride, "settled");
      assert.equal(settled.thread.pinnedAt, null);
      const shell = yield* store.getThreadShell(threadId);
      assert.ok(shell);
      const childShell = {
        ...shell,
        lineage: shell.lineage,
        pinnedAt: null,
      };
      assert.equal(
        archiveEligible(
          childShell,
          [childShell],
          DateTime.toEpochMillis(now) + 86_400_000,
          metadata,
        ),
        true,
      );
      assert.equal(
        archiveEligible(
          { ...childShell, autoSettleDisabledAt: now },
          [childShell],
          Infinity,
          metadata,
        ),
        false,
      );
      const descendant = {
        ...childShell,
        id: ThreadId.make("child"),
        lineage: childShell.lineage,
        settledOverride: null,
        status: "running" as const,
      };
      assert.equal(
        archiveEligible(
          childShell,
          [childShell, descendant],
          Infinity,
          metadata,
          new Map([
            [threadId, metadata],
            [
              descendant.id,
              { threadId: descendant.id, parentThreadId: threadId, settleOnComplete: true },
            ],
          ]),
        ),
        false,
      );
      assert.equal(
        archiveEligible(childShell, [childShell], Infinity, {
          ...metadata,
          settleOnComplete: false,
        }),
        false,
      );
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("repin"),
        threadId,
        orderKey: "a0",
      });
      const archived = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-pinned"),
          threadId,
          autoArchiveSettledBefore: now,
        }),
      );
      assert.equal(archived._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("manual-archive"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("unarchive"),
        threadId,
      });
      const restored = yield* store.getThreadShell(threadId);
      assert.ok(restored);
      assert.equal(restored.archivedAt, null);
      assert.equal(archiveDeadline(restored, 7), null);
      const restoredThread = (yield* store.getThreadProjection(threadId)).thread;
      yield* store.apply({
        id: EventId.make("nested-retention"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: {
          ...restoredThread,
          lineage: childShell.lineage,
          pinnedAt: null,
          updatedAt: now,
          settledOverride: "settled",
          settledAt: now,
        },
      });
      const retentionShell = (yield* store.getThreadShell(threadId))!;
      assert.equal(
        archiveDeadline(retentionShell, 7),
        DateTime.toEpochMillis(now) + 7 * 86_400_000,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* WorkerLifecycle.WorkerLifecycle;
          yield* first.drain;
        }).pipe(Effect.provide(WorkerLifecycle.layer)),
      );
      assert.equal((yield* store.getThreadProjection(threadId)).thread.archivedAt, null);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* WorkerLifecycle.WorkerLifecycle;
          yield* restarted.drain;
          const archivedReceipt = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "thread.archived" && event.threadId === threadId,
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* TestClock.adjust("1 day");
          yield* Fiber.join(archivedReceipt);
          assert.isNotNull((yield* store.getThreadProjection(threadId)).thread.archivedAt);
          yield* restarted.drain;
        }).pipe(Effect.provide(WorkerLifecycle.layer)),
      );
    }).pipe(
      Effect.provide(
        WorkerLifecycle.layer.pipe(
          Layer.provideMerge(ThreadManagement.layer),
          Layer.provideMerge(testLayer),
          Layer.provideMerge(ServerSettings.layerTest({ settledSubthreadArchiveAfterDays: 1 })),
        ),
      ),
    ),
);

// Day Planner 4fdb3daf (2026-10-10): every delivery after an explicit unsettle
// reset "active" to null, so the next completed run auto-settled it again.
it.effect("keeps an explicitly unsettled worker active after a delivery completes", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const lifecycle = yield* WorkerLifecycle.WorkerLifecycle;
    yield* initializeMetadata(sql);
    const threadId = ThreadId.make("unsettled-worker");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-unsettled-worker"),
      threadId,
      projectId: ProjectId.make("project"),
      title: "Unsettled worker",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeMetadata(sql, {
      threadId,
      parentThreadId: ThreadId.make("parent"),
      settleOnComplete: true,
    });
    const complete = (id: string, ordinal: number, userMessageId: MessageId) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`complete-${id}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: RunId.make(id),
                threadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
      });
    yield* complete("first-run", 1, MessageId.make("first-message"));
    yield* lifecycle.drain;
    assert.equal((yield* store.getThread(threadId)).settledOverride, "settled");

    yield* threads.dispatch({
      type: "thread.unsettle",
      reason: "user",
      commandId: CommandId.make("user-unsettle"),
      threadId,
    });
    assert.equal((yield* store.getThread(threadId)).settledOverride, "active");
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("delivery"),
      threadId,
      messageId: MessageId.make("delivery-message"),
      text: "progress",
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
    });
    const delivered = (yield* store.getThreadProjection(threadId)).runs.find(
      (run) => run.userMessageId === MessageId.make("delivery-message"),
    );
    assert.ok(delivered);
    yield* complete(delivered.id, delivered.ordinal, delivered.userMessageId);
    yield* lifecycle.drain;
    assert.equal((yield* store.getThread(threadId)).settledOverride, "active");
  }).pipe(
    Effect.provide(
      WorkerLifecycle.layer.pipe(
        Layer.provideMerge(ThreadManagement.layer),
        Layer.provideMerge(testLayer),
        Layer.provideMerge(ServerSettings.layerTest({})),
      ),
    ),
  ),
);

// Trace real SQL rather than counting calls to a mocked projection store.
function shellReadCounter() {
  const queries: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") queries.push(query);
      };
      return span;
    },
  });
  return {
    tracer,
    queries,
    shellReads: () =>
      queries.filter((query) => query.includes("AS forked_from_run_source_thread_id")),
  };
}

const archiveFixture = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const ids = [
    "archive-root",
    "archive-worker",
    "archive-child",
    "archive-nested",
    "archive-leaf",
  ].map((id) => ThreadId.make(id));
  for (const [index, threadId] of ids.entries()) {
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${threadId}`),
      threadId,
      projectId: ProjectId.make("archive-project"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    if (index === 0) continue;
    yield* writeMetadata(sql, { threadId, parentThreadId: ids[index - 1]! });
    const thread = yield* store.getThread(threadId);
    yield* store.apply({
      id: EventId.make(`settled-${threadId}`),
      type: "thread.settled",
      threadId,
      occurredAt: now,
      payload: { ...thread, settledOverride: "settled", settledAt: now },
    });
  }
  for (const threadId of ids.slice(2, 4)) {
    yield* threads.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`archive-${threadId}`),
      threadId,
    });
  }
  return { ids, threads, store, now };
});

const archiveTestLayer = ThreadManagement.layer.pipe(
  Layer.provideMerge(testLayer),
  Layer.provideMerge(ServerSettings.layerTest({ settledSubthreadArchiveAfterDays: 1 })),
);

it.effect("reads archived shells once per lifecycle update, including nested archives", () =>
  Effect.gen(function* () {
    const { ids, threads, store } = yield* archiveFixture;
    const snapshot = yield* threads.getShellSnapshot();
    const archive = yield* threads.getShellSnapshot({ location: "archive" });
    assert.deepEqual(snapshot.archivedThreads, archive.archivedThreads);
    assert.deepEqual(
      snapshot.archivedThreads.map((thread) => thread.id).toSorted(),
      ids.slice(2, 4).toSorted(),
    );
    const counter = shellReadCounter();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* WorkerLifecycle.WorkerLifecycle;
        counter.queries.length = 0;
        yield* lifecycle.drain;
      }).pipe(Effect.provide(WorkerLifecycle.layer), Effect.withTracer(counter.tracer)),
    );
    assert.equal(
      counter.shellReads().length,
      1,
      `SQL statements: ${counter.queries.length}; shell reads: ${counter.shellReads().length}`,
    );
    assert.equal(
      counter
        .shellReads()
        .filter((query) =>
          query.includes("json_extract(t.payload_json, '$.archivedAt') IS NOT NULL"),
        ).length,
      0,
    );
    assert.deepEqual((yield* threads.getShellSnapshot()).threads, snapshot.threads);
    assert.deepEqual((yield* threads.getShellSnapshot()).archivedThreads, snapshot.archivedThreads);
    assert.equal((yield* store.getThread(ids[1]!)).archivedAt, null);
  }).pipe(Effect.provide(archiveTestLayer)),
);

it.effect(
  "archives eligible parents through nested archives and rechecks concurrent descendant updates",
  () =>
    Effect.gen(function* () {
      const { ids, threads, store, now } = yield* archiveFixture;
      const workerId = ids[1]!;
      const leafId = ids[4]!;
      yield* TestClock.adjust("1 day");
      const leaf = yield* store.getThread(leafId);
      yield* store.apply({
        id: EventId.make("leaf-retention-update"),
        type: "thread.metadata-updated",
        threadId: leafId,
        occurredAt: yield* DateTime.now,
        payload: { ...leaf, updatedAt: yield* DateTime.now },
      });
      const before = yield* threads.getShellSnapshot();
      // A descendant changes after the sweep's read, before its command reaches the lock.
      let raced = false;
      const racingThreads = ThreadManagement.ThreadManagementService.of({
        ...threads,
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "thread.archive" && command.threadId === workerId && !raced) {
              raced = true;
              yield* threads.dispatch({
                type: "thread.unsettle",
                commandId: CommandId.make("concurrent-unsettle"),
                threadId: leafId,
                reason: "user",
              });
            }
            return yield* threads.dispatch(command);
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* WorkerLifecycle.WorkerLifecycle;
          yield* lifecycle.drain;
        }).pipe(
          Effect.provide(WorkerLifecycle.layer),
          Effect.provideService(ThreadManagement.ThreadManagementService, racingThreads),
        ),
      );
      assert.equal(raced, true);
      assert.equal((yield* store.getThread(workerId)).archivedAt, null);
      assert.equal((yield* store.getThread(leafId)).settledOverride, "active");
      assert.deepEqual((yield* threads.getShellSnapshot()).archivedThreads, before.archivedThreads);

      // A subsequent sweep must see the active grandchild through both archived ancestors.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* WorkerLifecycle.WorkerLifecycle;
          yield* lifecycle.drain;
        }).pipe(Effect.provide(WorkerLifecycle.layer)),
      );
      assert.equal((yield* store.getThread(workerId)).archivedAt, null);
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-leaf-again"),
        threadId: leafId,
      });
      const counter = shellReadCounter();
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("eligible-archive"),
          threadId: workerId,
          autoArchiveSettledBefore: now,
        })
        .pipe(Effect.withTracer(counter.tracer));
      assert.equal(
        counter.shellReads().length,
        1,
        `SQL statements: ${counter.queries.length}; shell reads: ${counter.shellReads().length}`,
      );
      assert.isNotNull((yield* store.getThread(workerId)).archivedAt);
      const after = yield* threads.getShellSnapshot();
      assert.deepEqual(
        after.threads.map((thread) => thread.id).toSorted(),
        [ids[0]!, leafId].toSorted(),
      );
      assert.deepEqual(
        after.archivedThreads.map((thread) => thread.id).toSorted(),
        ids.slice(1, 4).toSorted(),
      );
    }).pipe(Effect.provide(archiveTestLayer)),
);

it.effect("reads archived shells once in the fresh archive command-lock check", () =>
  Effect.gen(function* () {
    const { ids, threads, store, now } = yield* archiveFixture;
    const counter = shellReadCounter();
    yield* threads
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-counted"),
        threadId: ids[1]!,
        autoArchiveSettledBefore: now,
      })
      .pipe(Effect.withTracer(counter.tracer));
    assert.isNotNull((yield* store.getThread(ids[1]!)).archivedAt);
    assert.equal(
      counter.shellReads().length,
      1,
      `SQL statements: ${counter.queries.length}; shell reads: ${counter.shellReads().length}`,
    );
  }).pipe(Effect.provide(archiveTestLayer)),
);
