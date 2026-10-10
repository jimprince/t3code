import { it } from "@effect/vitest";
import { assert } from "vite-plus/test";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { withWorkerSummaries } from "../forkThreads/WorkerSummaryService.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const TestLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect(
  "batch shells preserve archived, settled, nested and fork-source shells in caller order",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.makeUnsafe("2026-10-10T00:00:00Z");
      const ids = Array.from({ length: 8 }, (_, i) => ThreadId.make(`thread:batch:${i}`));
      for (const [i, id] of ids.entries()) {
        yield* store.apply({
          id: EventId.make(`event:batch:${i}`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id,
            projectId: ProjectId.make("project:batch"),
            title: `Thread ${i}`,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: i === 0 ? null : ids[0]!,
              relationshipToParent: i === 0 ? null : "fork",
              rootThreadId: ids[0]!,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: i === 1 ? now : null,
            settledOverride: i === 2 ? "settled" : null,
            settledAt: i === 2 ? now : null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      }
      for (const [i, threadId] of ids.entries()) {
        const runId = RunId.make(`run:batch:${i}`);
        const messageId = MessageId.make(`message:batch:${i}`);
        yield* store.apply({
          id: EventId.make(`event:run:batch:${i}`),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
            providerThreadId: null,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: i === 3 ? "failed" : i === 4 ? "rolled_back" : "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:message:batch:${i}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: `question ${i}`,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: "user",
            creationSource: "web",
          },
        });
        yield* store.apply({
          id: EventId.make(`event:item:batch:${i}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:batch:${i}`),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: i === 5 ? "running" : "completed",
            title: "command",
            startedAt: now,
            completedAt: i === 5 ? null : now,
            updatedAt: now,
            type: "command_execution",
            input: "echo fixture",
          },
        });
      }
      for (const [i, threadId] of ids.entries()) {
        for (const suffix of ["z", "a"])
          yield* store.apply({
            id: EventId.make(`event:provider:${i}:${suffix}`),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: ProviderThreadId.make(`provider:${i}:${suffix}`),
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make(suffix === "z" ? "codex" : "alternate"),
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [
                { taskId: `task:${i}:${suffix}`, kind: "command", description: suffix },
              ],
              createdAt: now,
              updatedAt: now,
            },
          });
      }
      const ordered = [ids[7]!, ids[1]!, ids[2]!, ...ids.slice(0, 7), ThreadId.make("missing")];
      const expected = yield* Effect.forEach(ordered, store.getThreadShell);
      assert.strictEqual(encodeJson(yield* store.getThreadShells(ordered)), encodeJson(expected));
      assert.strictEqual((yield* store.getThreadShells([])).length, 0);
      const snapshot = yield* store.getShellSnapshot();
      const snapshotById = new Map(
        [...snapshot.threads, ...snapshot.archivedThreads].map((shell) => [shell.id, shell]),
      );
      assert.strictEqual(
        encodeJson(expected),
        encodeJson(ordered.map((id) => snapshotById.get(id) ?? null)),
      );

      // An ancestor outside the batch, a missing ancestor and a cycle all terminate.
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json, '$.forkedFrom', json(${encodeJson({ type: "run", threadId: ids[0], runId: RunId.make("run:batch:0") })})) WHERE thread_id=${ids[7]}`;
      assert.strictEqual(
        encodeJson(yield* store.getThreadShells([ids[7]!])),
        encodeJson([yield* store.getThreadShell(ids[7]!)]),
      );
      assert.isAbove(
        (yield* store.getThreadShells([ids[7]!]))[0]!.visibleItemCount,
        expected[0]!.visibleItemCount,
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json, '$.forkedFrom', json(${encodeJson({ type: "run", threadId: ids[7], runId: RunId.make("run:batch:7") })})) WHERE thread_id=${ids[0]}`;
      assert.strictEqual(
        encodeJson(yield* store.getThreadShells([ids[7]!, ids[0]!])),
        encodeJson(yield* Effect.forEach([ids[7]!, ids[0]!], store.getThreadShell)),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json, '$.forkedFrom.threadId', 'missing') WHERE thread_id=${ids[7]}`;
      assert.strictEqual(
        encodeJson(yield* store.getThreadShells([ids[7]!])),
        encodeJson([yield* store.getThreadShell(ids[7]!)]),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='deleted' WHERE thread_id=${ids[1]}`;
      assert.isNull((yield* store.getThreadShells([ids[1]!]))[0]);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("eight shells execute five native query families once per batch", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.makeUnsafe("2026-10-10T00:00:00Z");
    const ids = Array.from({ length: 8 }, (_, i) => ThreadId.make(`thread:counter:${i}`));
    for (const id of ids)
      yield* store.apply({
        id: EventId.make(`event:${id}`),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id,
          projectId: ProjectId.make("project:counter"),
          title: "counter",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
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
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
    const statements: string[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    yield* store.getThreadShells(ids).pipe(Effect.withTracer(tracer));
    assert.strictEqual(statements.length, 5);
    for (const id of ids.slice(1))
      yield* sql`INSERT INTO fork_thread_metadata(thread_id,payload) VALUES(${id},${encodeJson({ parentThreadId: "parent" })})`;
    statements.length = 0;
    const service = yield* withWorkerSummaries(ThreadManagement.ThreadManagementService).pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
          getThreadShells: (ids) => store.getThreadShells(ids).pipe(Effect.orDie),
        }),
      ),
      Effect.withTracer(tracer),
    );
    const perThread = yield* Effect.forEach(ids, service.getThreadShell).pipe(
      Effect.withTracer(tracer),
    );
    assert.strictEqual(statements.length, 56);
    assert.strictEqual(statements.filter((query) => query.includes("sqlite_master")).length, 1);
    statements.length = 0;
    const batch = yield* service.getThreadShells(ids).pipe(Effect.withTracer(tracer));
    assert.strictEqual(encodeJson(batch), encodeJson(perThread));
    assert.strictEqual(statements.length, 7);
    assert.strictEqual(statements.filter((query) => query.includes("sqlite_master")).length, 0);
    // The schema is fixed at construction, but organizational metadata is fresh.
    yield* sql`DELETE FROM fork_thread_metadata WHERE thread_id=${ids[1]}`;
    assert.isUndefined((yield* service.getThreadShells([ids[1]!]))[0]?.workerSummary);
    assert.isUndefined(batch[0]?.workerSummary);
    assert.isDefined(batch[1]?.workerSummary);
    assert.strictEqual(
      (yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
      8,
    );
  }).pipe(Effect.provide(TestLayer)),
);
