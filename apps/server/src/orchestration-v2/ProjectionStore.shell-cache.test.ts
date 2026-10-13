import { it } from "@effect/vitest";
import { assert } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  RuntimeRequestId,
  ProviderTurnId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const TestLayer = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const now = DateTime.makeUnsafe("2026-10-12T00:00:00Z");
const later = DateTime.makeUnsafe("2026-10-12T01:00:00Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-6.1-sol" };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const threadFixture = (id: ThreadId): OrchestrationV2AppThread => ({
  id,
  createdBy: "user",
  creationSource: "web",
  projectId: ProjectId.make("project:cache"),
  title: id,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const createThread = Effect.fn(function* (id: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const thread = threadFixture(id);
  yield* store.apply({
    id: EventId.make(`create:${id}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: thread,
  });
  return thread;
});

const assertParity = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  for (const location of [undefined, "active", "archive"] as const) {
    for (const unsettledOnly of [false, true]) {
      const options = { ...(location === undefined ? {} : { location }), unsettledOnly };
      const cached = yield* store.getShellSnapshot(options);
      // Transactional callers deliberately use the original uncached production path.
      const fresh = yield* sql.withTransaction(store.getShellSnapshot(options));
      assert.strictEqual(encodeJson(cached), encodeJson(fresh));
      assert.strictEqual(yield* store.getShellSnapshot(options), cached);
    }
  }
});

it.effect(
  "cached shells equal fresh snapshots after projection lifecycle and dependency changes",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const id = ThreadId.make("thread:cache:source");
      const childId = ThreadId.make("thread:cache:child");
      const untouchedId = ThreadId.make("thread:cache:untouched");
      let serial = 0;
      const apply = (event: OrchestrationV2DomainEvent) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* events.append({ events: [event] });
              yield* store.apply(event);
            }),
          )
          .pipe(Effect.andThen(assertParity));
      const thread = threadFixture(id);
      const runId = RunId.make("run:cache");
      const messageId = MessageId.make("message:cache");
      yield* assertParity;
      for (const payload of [thread, threadFixture(childId), threadFixture(untouchedId)]) {
        yield* apply({
          id: EventId.make(`sequence:${serial++}`),
          type: "thread.created",
          threadId: payload.id,
          occurredAt: now,
          payload,
        });
      }
      const run = {
        id: runId,
        threadId: id,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued" as const,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "run.created",
        threadId: id,
        occurredAt: now,
        payload: run,
      });
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "message.updated",
        threadId: id,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId: id,
          runId,
          nodeId: null,
          role: "user",
          text: "Cache fixture",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "thread.metadata-updated",
        threadId: childId,
        occurredAt: now,
        payload: {
          ...threadFixture(childId),
          forkedFrom: { type: "run", threadId: id, runId },
          lineage: { parentThreadId: id, relationshipToParent: "fork", rootThreadId: id },
        },
      });
      const item = {
        id: TurnItemId.make("item:cache"),
        threadId: id,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: "fixture command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution" as const,
        input: "echo fixture",
      };
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "turn-item.updated",
        threadId: id,
        occurredAt: now,
        payload: item,
      });
      assert.strictEqual((yield* store.getThreadShell(childId))?.visibleItemCount, 2);
      for (const status of ["running", "waiting", "completed", "rolled_back"] as const) {
        yield* apply({
          id: EventId.make(`sequence:${serial++}`),
          type: "run.updated",
          threadId: id,
          occurredAt: later,
          payload: {
            ...run,
            status,
            startedAt: now,
            completedAt: status === "completed" || status === "rolled_back" ? later : null,
          },
        });
      }
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "turn-item.updated",
        threadId: id,
        occurredAt: later,
        payload: { ...item, status: "completed", completedAt: later, updatedAt: later },
      });
      const plan = {
        id: PlanId.make("plan:cache"),
        threadId: id,
        runId,
        nodeId: NodeId.make("node:cache"),
        kind: "todo_list" as const,
        status: "active" as const,
        steps: [{ id: "step:cache", text: "Fixture", status: "pending" as const }],
      };
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "plan.updated",
        threadId: id,
        occurredAt: later,
        payload: plan,
      });
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "plan.updated",
        threadId: id,
        occurredAt: later,
        payload: { ...plan, steps: [{ ...plan.steps[0]!, status: "completed" }] },
      });
      const request = {
        id: RuntimeRequestId.make("request:cache"),
        nodeId: plan.nodeId,
        providerTurnId: ProviderTurnId.make("provider-turn:cache"),
        nativeRequestRef: null,
        kind: "command" as const,
        status: "pending" as const,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("session:cache"),
        },
        createdAt: now,
        resolvedAt: null,
      };
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "runtime-request.updated",
        threadId: id,
        occurredAt: later,
        payload: request,
      });
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "runtime-request.updated",
        threadId: id,
        occurredAt: later,
        payload: { ...request, status: "resolved", resolvedAt: later },
      });
      const session = {
        id: ProviderSessionId.make("session:cache"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId,
        status: "ready" as const,
        cwd: "/synthetic",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const threadId of [id, childId]) {
        yield* apply({
          id: EventId.make(`sequence:${serial++}`),
          type: "provider-session.attached",
          threadId,
          driver: session.driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "provider-session.updated",
        threadId: id,
        occurredAt: later,
        payload: {
          ...session,
          status: "error",
          lastError: "Shared session failed",
          updatedAt: later,
        },
      });
      assert.strictEqual(
        (yield* store.getShellSnapshot()).threads.find((t) => t.id === childId)?.lastError,
        "Shared session failed",
      );
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "provider-session.detached",
        threadId: childId,
        occurredAt: later,
        payload: { providerSessionId: session.id, detachedAt: later },
      });
      const providerThread = {
        id: ProviderThreadId.make("provider-thread:cache"),
        driver: session.driver,
        providerInstanceId,
        providerSessionId: session.id,
        appThreadId: id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "background:cache", kind: "command" as const, description: "fixture" },
        ],
      };
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "provider-thread.updated",
        threadId: id,
        occurredAt: later,
        payload: providerThread,
      });
      yield* apply({
        id: EventId.make(`sequence:${serial++}`),
        type: "provider-thread.updated",
        threadId: childId,
        occurredAt: later,
        payload: { ...providerThread, appThreadId: childId },
      });
      for (const [type, payload] of [
        [
          "thread.metadata-updated",
          {
            ...thread,
            title: "Renamed",
            projectId: ProjectId.make("project:moved"),
            updatedAt: later,
          },
        ],
        [
          "thread.settled",
          { ...thread, settledAt: later, settledOverride: "settled", updatedAt: later },
        ],
        ["thread.unsettled", { ...thread, unsettledAt: later, updatedAt: later }],
        ["thread.archived", { ...thread, archivedAt: later, updatedAt: later }],
        ["thread.unarchived", { ...thread, updatedAt: later }],
        ["thread.deleted", { ...thread, deletedAt: later, updatedAt: later }],
      ] as const) {
        yield* apply({
          id: EventId.make(`sequence:${serial++}`),
          type,
          threadId: id,
          occurredAt: later,
          payload,
        });
      }
      // Direct SQL updates and source deletion are also transactional invalidations.
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json, '$.title', 'Direct writer') WHERE thread_id=${untouchedId}`;
      yield* assertParity;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id=${id}`;
      yield* assertParity;
      assert.strictEqual(
        (yield* store.getShellSnapshot()).threads.find((t) => t.id === childId)?.visibleItemCount,
        0,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("transaction rollback cannot consume invalidations or publish uncommitted shells", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const id = ThreadId.make("thread:cache:rollback");
    const thread = yield* createThread(id);
    const original = yield* store.getShellSnapshot();
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* store.apply({
            id: EventId.make("rename:rollback"),
            type: "thread.metadata-updated",
            threadId: id,
            occurredAt: later,
            payload: { ...thread, title: "Uncommitted", updatedAt: later },
          });
          assert.strictEqual((yield* store.getShellSnapshot()).threads[0]?.title, "Uncommitted");
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.ignore);
    assert.strictEqual(yield* store.getShellSnapshot(), original);
    yield* assertParity;
    yield* sql.withTransaction(
      store.apply({
        id: EventId.make("rename:commit"),
        type: "thread.metadata-updated",
        threadId: id,
        occurredAt: later,
        payload: { ...thread, title: "Committed", updatedAt: later },
      }),
    );
    yield* assertParity;
    const snapshots = yield* Effect.all(
      Array.from({ length: 8 }, () => store.getShellSnapshot()),
      { concurrency: "unbounded" },
    );
    assert.isTrue(snapshots.every((snapshot) => snapshot === snapshots[0]));
    assert.strictEqual(snapshots[0]?.threads[0]?.title, "Committed");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rebuild invalidates cached shells even when the event store is empty", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* createThread(ThreadId.make("thread:cache:rebuild"));
    assert.lengthOf((yield* store.getShellSnapshot()).threads, 1);
    const verification = yield* maintenance.rebuild;
    assert.isTrue(verification.valid);
    assert.lengthOf((yield* store.getShellSnapshot()).threads, 0);
    yield* assertParity;
  }).pipe(Effect.provide(ProjectionMaintenance.layer.pipe(Layer.provideMerge(TestLayer)))),
);

it.effect(
  "T3CODE_SHELL_SNAPSHOT_CACHE=0 bypasses the cache and installs no invalidation journal",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* createThread(ThreadId.make("thread:cache:disabled"));
      const first = yield* store.getShellSnapshot();
      const second = yield* store.getShellSnapshot();
      assert.notStrictEqual(first, second);
      assert.strictEqual(encodeJson(first), encodeJson(second));
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_temp_master WHERE name LIKE 'shell_snapshot_dirty_%'`,
        0,
      );
    }).pipe(
      Effect.provide(
        TestLayer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { T3CODE_SHELL_SNAPSHOT_CACHE: "0" } }),
            ),
          ),
        ),
      ),
    ),
);

it.effect(
  "warm reads reuse shells without querying projection rows and refresh only dirty threads",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const id = ThreadId.make("thread:cache:query:1");
      const otherId = ThreadId.make("thread:cache:query:2");
      const firstThread = yield* createThread(id);
      yield* createThread(otherId);
      const first = yield* store.getShellSnapshot();
      const queries: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") queries.push(query);
          };
          return span;
        },
      });
      assert.strictEqual(yield* store.getShellSnapshot().pipe(Effect.withTracer(tracer)), first);
      assert.isFalse(queries.some((query) => query.includes("orchestration_v2_projection_")));
      yield* store.apply({
        id: EventId.make("rename:query"),
        type: "thread.metadata-updated",
        threadId: id,
        occurredAt: later,
        payload: { ...firstThread, title: "Refresh one", updatedAt: later },
      });
      queries.length = 0;
      const updated = yield* store.getShellSnapshot().pipe(Effect.withTracer(tracer));
      const shellQuery = queries.find((query) => query.includes("latest_run_status"))!;
      assert.match(shellQuery, /"t"\."thread_id" IN \(\?\)/);
      assert.strictEqual(updated.threads.find((t) => t.id === id)?.title, "Refresh one");
      yield* assertParity;
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "filtered reads preserve uncached behavior when an excluded projection cannot decode",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const id = ThreadId.make("thread:cache:valid");
      const archivedId = ThreadId.make("thread:cache:invalid-archive");
      yield* createThread(id);
      const archived = yield* createThread(archivedId);
      yield* store.apply({
        id: EventId.make("archive:invalid"),
        type: "thread.archived",
        threadId: archivedId,
        occurredAt: later,
        payload: { ...archived, archivedAt: later, updatedAt: later },
      });
      yield* store.getShellSnapshot({ location: "active" });
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json, '$.title', NULL) WHERE thread_id=${archivedId}`;
      const options = { location: "active" as const };
      const cached = yield* store.getShellSnapshot(options);
      assert.strictEqual(
        encodeJson(cached),
        encodeJson(yield* sql.withTransaction(store.getShellSnapshot(options))),
      );
      assert.deepEqual(
        cached.threads.map((thread) => thread.id),
        [id],
      );
      assert.isTrue((yield* Effect.result(store.getShellSnapshot()))._tag === "Failure");
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("another SQLite connection invalidates cached shells", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filename = `${directory}/synthetic.sqlite`;
    yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const id = ThreadId.make("thread:cache:external");
      yield* createThread(id);
      assert.strictEqual((yield* store.getShellSnapshot()).threads[0]?.title, id);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json, '$.title', 'External writer') WHERE thread_id=${id}`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      assert.strictEqual((yield* store.getShellSnapshot()).threads[0]?.title, "External writer");
      yield* assertParity;
    }).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(Layer.provideMerge(makeSqlitePersistenceLive(filename))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.env.T3_BENCH_SHELL_CACHE !== "1")(
  "shell snapshot timing on 300 synthetic threads",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (let i = 0; i < 300; i++) {
        const threadId = ThreadId.make(`thread:benchmark:${i}`);
        yield* createThread(threadId);
        for (let ordinal = 1; ordinal <= 3; ordinal++) {
          const runId = RunId.make(`run:benchmark:${i}:${ordinal}`);
          yield* store.apply({
            id: EventId.make(`event:${runId}`),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message:${runId}`),
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
          yield* store.apply({
            id: EventId.make(`event:item:${runId}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:${runId}`),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "synthetic command",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "command_execution",
              input: "echo fixture",
            },
          });
        }
      }
      const warmupStart = performance.now();
      const expected = yield* store.getShellSnapshot();
      const coldMs = performance.now() - warmupStart;
      assert.lengthOf(expected.threads, 300);
      const measure = (
        read: Effect.Effect<unknown, ProjectionStore.ProjectionStoreV2Error>,
        count: number,
      ) =>
        Effect.gen(function* () {
          const start = performance.now();
          for (let i = 0; i < count; i++) yield* read;
          return (performance.now() - start) / count;
        });
      yield* Effect.gen(function* () {
        const uncached = yield* ProjectionStore.ProjectionStoreV2;
        const cachedMs = yield* measure(store.getShellSnapshot(), 50);
        const uncachedMs = yield* measure(uncached.getShellSnapshot(), 15);
        assert.strictEqual(encodeJson(expected), encodeJson(yield* uncached.getShellSnapshot()));
        if (process.env.T3_SHELL_CACHE_BENCH_OUTPUT !== undefined) {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            process.env.T3_SHELL_CACHE_BENCH_OUTPUT,
            encodeJson({
              threads: 300,
              runs: 900,
              items: 900,
              cachedReads: 50,
              uncachedReads: 15,
              coldMs,
              cachedMs,
              uncachedMs,
              speedup: uncachedMs / cachedMs,
            }),
          );
        }
        yield* Console.log(
          `SHELL_CACHE_BENCH threads=300 runs=900 items=900 cold_ms=${coldMs.toFixed(3)} cached_ms=${cachedMs.toFixed(3)} uncached_ms=${uncachedMs.toFixed(3)} speedup=${(uncachedMs / cachedMs).toFixed(1)}x`,
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(ProjectionStore.layer).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { T3CODE_SHELL_SNAPSHOT_CACHE: "0" } }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(TestLayer, NodeServices.layer))),
  60_000,
);
