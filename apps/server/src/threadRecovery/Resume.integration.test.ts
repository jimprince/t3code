import { assert, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import * as Reset from "./SessionResetService.ts";
import * as Incarnation from "./ServerIncarnation.ts";
import { RecoveryAuthority } from "./RecoveryAuthority.ts";
import { runtime } from "./Resume.testkit.ts";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const seedProject = ProjectStore.ProjectStoreV2.use((s) =>
  s.apply({
    sequence: 0,
    eventId: EventId.make("seed-project"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("test"),
    occurredAt: "2026-10-10T00:00:00Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: ProjectId.make("test"),
      title: "test",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: "2026-10-10T00:00:00Z",
      updatedAt: "2026-10-10T00:00:00Z",
    },
  }),
);
const admin = {
  principal: "recovery-operator",
  scopes: [AuthAccessWriteScope, AuthOrchestrationOperateScope],
};

it.live(
  "resume CAS starts exactly one real run, survives retry/reconstruction, and refuses stale, changed and concurrent callers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedProject;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const service = yield* Reset.SessionResetService;
        const store = yield* RecoveryStore.RecoveryStore;
        const threadId = ThreadId.make("resume-cas");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("resume-cas-create"),
          threadId,
          projectId: ProjectId.make("test"),
          title: "resume",
          branch: null,
          worktreePath: null,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        });
        yield* store.advance(threadId, 0);
        const input = {
          threadId,
          expectedGeneration: 1,
          requestId: "once",
          message: "Continue the work",
        };
        const stale = yield* Effect.result(service.resume({ ...input, expectedGeneration: 0 }));
        assert.equal(stale._tag, "Failure", "stale generation must refuse a new turn");
        if (stale._tag === "Failure") assert.equal(stale.failure.code, "conflict");
        assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 0);
        const first = yield* service.resume(input);
        assert.isDefined(
          yield* store.get("resume:recovery-operator:once"),
          "run commit must persist its retry receipt",
        );
        const [a, b] = yield* Effect.all([service.resume(input), service.resume(input)], {
          concurrency: 2,
        });
        assert.deepEqual(first, a);
        assert.deepEqual(a, b);
        assert.equal(a.generation, 1);
        let p = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(p.runs.length, 1);
        assert.equal(p.runs[0]?.id, a.runId);
        assert.notEqual(p.runs[0]?.status, "queued");
        assert.equal(
          p.messages.find((m) => m.id === p.runs[0]?.userMessageId)?.text,
          "Continue the work",
        );
        assert.equal(
          (yield* service.resume({ ...input, message: "Different" }).pipe(Effect.flip)).code,
          "conflict",
        );
        assert.equal(
          (yield* service.resume({ ...input, requestId: "second" }).pipe(Effect.flip)).code,
          "conflict",
        );
        yield* store.advance(threadId, 1);
        assert.deepEqual(yield* service.resume(input), a);
        // A fresh service/server runtime reads the same persisted receipt and epoch.
        const before = yield* service.generation({ threadId });
        const after = yield* Effect.gen(function* () {
          const restarted = yield* Reset.SessionResetService;
          assert.deepEqual(yield* restarted.resume(input), a);
          return yield* restarted.generation({ threadId });
        }).pipe(
          Effect.provide(Layer.fresh(Reset.layer.pipe(Layer.provideMerge(Incarnation.layer)))),
        );
        assert.equal(after.generation, 2);
        assert.notEqual(before.serverIncarnation, after.serverIncarnation);
        p = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(p.runs.length, 1);
      }),
    ).pipe(Effect.provideService(RecoveryAuthority, admin), Effect.provide(runtime)),
);

it.live("resume refuses pending reset and rolls its receipt back if run commit fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const service = yield* Reset.SessionResetService;
      const store = yield* RecoveryStore.RecoveryStore;
      const threadId = ThreadId.make("resume-rollback");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("resume-rollback-create"),
        threadId,
        projectId: ProjectId.make("test"),
        title: "resume",
        branch: null,
        worktreePath: null,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
      yield* store.save("reset:test:pending", "test", "pending", { threadId, status: "fenced" });
      const input = { threadId, expectedGeneration: 0, requestId: "rollback" };
      assert.equal((yield* service.resume(input).pipe(Effect.flip)).code, "pending");
      yield* store.save("reset:test:pending", "test", "pending", { threadId, status: "completed" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        "CREATE TEMP TRIGGER fail_resume BEFORE INSERT ON orchestration_v2_projection_runs BEGIN SELECT RAISE(ABORT,'injected resume failure'); END",
      );
      yield* service.resume(input).pipe(Effect.flip);
      assert.isUndefined(yield* store.get("resume:recovery-operator:rollback"));
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 0);
      yield* sql.unsafe("DROP TRIGGER fail_resume");
      const active = yield* service.resume({ ...input, requestId: "active-before-queue" });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("preserved-queue"),
        threadId,
        messageId: MessageId.make("preserved-queue-message"),
        text: "Queued human work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (r) => r.status === "queued",
      )!;
      assert.equal(queuedRun.status, "queued");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("preserve-queued-on-interrupt"),
        threadId,
        runId: active.runId,
      });
      const receipt = yield* service.resume(input);
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.notEqual(runs.find((r) => r.id === receipt.runId)?.status, "queued");
      assert.equal(runs.find((r) => r.id === queuedRun.id)?.status, "queued");
    }),
  ).pipe(Effect.provideService(RecoveryAuthority, admin), Effect.provide(runtime)),
);

it.live(
  "production interrupt persists exact-run epoch and explicit pre-start fallback receipt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedProject;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const service = yield* Reset.SessionResetService;
        const store = yield* RecoveryStore.RecoveryStore;
        const threadId = ThreadId.make("interrupt-receipt");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("interrupt-receipt-create"),
          threadId,
          projectId: ProjectId.make("test"),
          title: "stop",
          branch: null,
          worktreePath: null,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        });
        yield* store.advance(threadId, 0);
        const receipt = yield* service.resume({
          threadId,
          expectedGeneration: 1,
          requestId: "start-for-interrupt",
        });
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("exact-stop"),
          threadId,
          runId: receipt.runId,
          reason: "test exact receipt",
        });
        const stop = yield* service.stopReceipt({ threadId, runId: receipt.runId });
        assert.equal(stop.generation, 1);
        assert.equal(stop.endedBy, "fallback");
        assert.equal(stop.terminal, true);
        assert.equal(stop.providerStopped, false);
        assert.isNotNull(stop.requestedAt);
        assert.isNotNull(stop.completedAt);
      }),
    ).pipe(Effect.provideService(RecoveryAuthority, admin), Effect.provide(runtime)),
);
