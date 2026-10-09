import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  SendBindingResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Management from "../orchestration-v2/ThreadManagementService.ts";
import { makeHandoffService } from "../forkThreads/HandoffService.ts";
import {
  makeSendBindingReader,
  recordSendBinding,
  SendBindingWrite,
} from "../forkThreads/SendBindings.ts";
import { runtime } from "./Resume.testkit.ts";

it.live(
  "send binding follows queued promotion and exact terminal timestamps, preserves held/unknown and commits native MCP mappings atomically",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* Management.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("binding-thread");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
        yield* ProjectStore.ProjectStoreV2.use((s) =>
          s.apply({
            sequence: 0,
            eventId: EventId.make("binding-project"),
            aggregateKind: "project",
            aggregateId: ProjectId.make("binding-project"),
            occurredAt: "2026-10-10T00:00:00Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: ProjectId.make("binding-project"),
              title: "binding",
              workspaceRoot: process.cwd(),
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: "2026-10-10T00:00:00Z",
              updatedAt: "2026-10-10T00:00:00Z",
            },
          }),
        );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("binding-create"),
          threadId,
          projectId: ProjectId.make("binding-project"),
          title: "binding",
          branch: null,
          worktreePath: null,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        });
        const sends = makeHandoffService(sql, threads, Effect.succeed([]), "sender");
        const reader = makeSendBindingReader(sql);
        const send = (sendId: string) => ({
          sendId,
          recipientThreadId: threadId,
          text: "follow-up",
          coalesceKey: null,
          intent: "auto" as const,
        });
        assert.deepEqual(yield* reader.read({ threadId, sendId: "missing" }), {
          threadId,
          sendId: "missing",
          state: "unknown",
          delivery: null,
          runId: null,
          run: null,
        });
        const first = yield* sends.accept(send("first"));
        const queued = yield* sends.accept(send("queued"));
        assert.equal(queued.status, "queued");
        assert.isString(queued.runId);
        const queuedBinding = yield* reader.read({ threadId, sendId: "queued" });
        yield* Schema.decodeUnknownEffect(SendBindingResult)(queuedBinding);
        assert.equal(queuedBinding.runId, queued.runId);
        assert.equal(queuedBinding.run?.startedAt, null);
        assert.equal(queuedBinding.run?.status, "queued");
        // Native interruption and queue continuation promote the same queued run.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("binding-interrupt"),
          threadId,
          runId: first.runId!,
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("binding-resume"),
          threadId,
        });
        const promoted = yield* reader.read({ threadId, sendId: "queued" });
        assert.equal(promoted.runId, queued.runId);
        assert.equal(promoted.delivery, "started");
        assert.notEqual(promoted.run?.status, "queued");
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (r) => r.id === queued.runId,
        )!;
        const startedAt = yield* DateTime.now;
        const completedAt = DateTime.add(startedAt, { seconds: 1 });
        yield* sink.write({
          events: [
            {
              id: EventId.make("binding-complete"),
              type: "run.updated",
              threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: completedAt,
              payload: { ...run, status: "completed", startedAt, completedAt },
            },
          ],
        });
        const complete = yield* reader.read({ threadId, sendId: "queued" });
        assert.equal(complete.run?.requestedAt, queuedBinding.run?.requestedAt);
        assert.equal(complete.run?.startedAt, DateTime.formatIso(startedAt));
        assert.equal(complete.run?.completedAt, DateTime.formatIso(completedAt));
        assert.isTrue(complete.run?.terminal);
        assert.equal(complete.run?.status, "completed");
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("binding-settle"),
          threadId,
        });
        yield* sends.accept(send("held"));
        assert.deepEqual(yield* reader.read({ threadId, sendId: "held" }), {
          threadId,
          sendId: "held",
          state: "pending",
          delivery: "held",
          runId: null,
          run: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make("binding-unsettle"),
          threadId,
          reason: "user",
        });
        // This is the same admission used by native MCP sends, not a post-send write.
        const commandId = CommandId.make("binding-mcp");
        const messageId = MessageId.make("binding-mcp-message");
        const sendNative = threads
          .sendToThread({
            projectId: ProjectId.make("binding-project"),
            commandId,
            threadId,
            messageId,
            text: "native send",
            attachments: [],
            mode: "auto",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.provideService(SendBindingWrite, {
              commandId,
              persist: recordSendBinding(sql, {
                threadId,
                sendId: "native / * request " + "x".repeat(130),
                namespace: "provider-session",
                messageId,
              }),
            }),
          );
        yield* sql`CREATE TEMP TRIGGER binding_abort BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(ABORT,'binding rollback'); END`;
        assert.equal((yield* Effect.result(sendNative))._tag, "Failure");
        assert.equal(
          (yield* reader.read({ threadId, sendId: "native / * request " + "x".repeat(130) })).state,
          "unknown",
        );
        yield* sql`DROP TRIGGER binding_abort`;
        const native = yield* sendNative;
        assert.equal(
          (yield* reader.read({ threadId, sendId: "native / * request " + "x".repeat(130) })).runId,
          native.run.id,
        );
      }),
    ).pipe(Effect.provide(runtime)),
);
