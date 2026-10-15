import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vite-plus/test";
import { AutomationStore } from "../automations/AutomationStore.ts";
import { makeSubheadRegistry } from "./SubheadRegistry.ts";
import { makeSubheadRuns } from "./SubheadRuns.ts";
import { makeSubheadCapacity } from "./SubheadCapacity.ts";
import { writeMetadata } from "./MetadataStore.ts";
import {
  subheadNativeLayer,
  subheadModel,
  subheadProject,
  createSubheadTestThread,
  sendSubheadTestMessage,
} from "./SubheadNative.testkit.ts";

const head = ThreadId.make("head");
const caller = {
  environmentId: "environment",
  principal: "script:test",
  threadId: null,
  runtimeMode: "full-access" as const,
};
const template = {
  name: "review",
  projectId: subheadProject,
  ownerThreadId: head,
  description: "Review",
  prompt: "Review",
  modelSelection: subheadModel,
  runtimeMode: "full-access" as const,
  concurrency: 1,
};

it.layer(NodeServices.layer)("shared head capacity", (it) => {
  it.effect(
    "a capped fresh launch preserves workspace preparation before queueing provider work",
    () =>
      Effect.gen(function* () {
        yield* createSubheadTestThread(head);
        const sql = yield* SqlClient.SqlClient;
        for (const id of ["prepare-busy-a", "prepare-busy-b", "fresh-workspace"]) {
          yield* createSubheadTestThread(ThreadId.make(id));
          yield* writeMetadata(sql, { threadId: ThreadId.make(id), parentThreadId: head });
        }
        yield* sendSubheadTestMessage(ThreadId.make("prepare-busy-a"));
        yield* sendSubheadTestMessage(ThreadId.make("prepare-busy-b"));
        const registry = yield* makeSubheadRegistry;
        yield* registry.create(template);
        yield* registry.setState("review", "enable");
        const threads = yield* Threads.ThreadManagementService;
        const threadId = ThreadId.make("fresh-workspace");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("fresh-workspace"),
          threadId,
          messageId: MessageId.make("fresh-workspace"),
          text: "Fresh",
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
        });
        const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs[0]!;
        expect(run.status).toBe("preparing");
        expect(run.workspacePreparation).toEqual({ type: "root" });
        yield* threads.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make("release-fresh-workspace"),
          threadId,
          runId: run.id,
        });
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs[0]?.status).toBe(
          "queued",
        );
        yield* threads.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("free-for-prepared"),
          threadId: ThreadId.make("prepare-busy-a"),
        });
        yield* threads.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-prepared"),
          threadId,
        });
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs[0]?.status).not.toBe(
          "queued",
        );
      }).pipe(Effect.provide(subheadNativeLayer)),
  );
  it.effect("released virtual leases do not retain slots through stale native work", () =>
    Effect.gen(function* () {
      yield* createSubheadTestThread(head);
      const registry = yield* makeSubheadRegistry;
      yield* registry.create({ ...template, concurrency: 2 });
      yield* registry.setState("review", "enable");
      const runs = yield* makeSubheadRuns;
      const capacity = yield* makeSubheadCapacity;
      const store = yield* AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* Threads.ThreadManagementService;
      const executions: ThreadId[] = [];
      for (const id of ["stale-a", "stale-b"]) {
        const run = yield* runs.send(
          { ...caller, principal: id },
          { name: "review", requestId: id, request: "Work" },
        );
        expect(yield* capacity.reserve(run.id)).toBe(true);
        const step = run.steps[0]!;
        executions.push(step.threadId);
        yield* createSubheadTestThread(step.threadId);
        yield* writeMetadata(sql, {
          threadId: step.threadId,
          parentThreadId: head,
          virtualRunId: run.id,
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId: step.threadId,
          messageId: step.messageId,
          text: step.prompt,
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        });
        yield* store.saveRun({ ...run, status: "failed", finishedAt: run.createdAt });
      }
      const idle = ThreadId.make("after-stale");
      yield* createSubheadTestThread(idle);
      yield* writeMetadata(sql, { threadId: idle, parentThreadId: head });
      expect(yield* capacity.canStart(idle)).toBe(true);
      yield* sendSubheadTestMessage(idle);
      const reused = executions[0]!;
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-old-virtual-turn"),
        threadId: reused,
      });
      yield* sendSubheadTestMessage(reused, "later-user-turn");
      const later = ThreadId.make("later-worker");
      yield* createSubheadTestThread(later);
      yield* writeMetadata(sql, { threadId: later, parentThreadId: head });
      expect(yield* capacity.canStart(later)).toBe(false);
    }).pipe(Effect.provide(subheadNativeLayer)),
  );
  it.effect("a previously queued ordinary turn cannot bypass a full head on resume", () =>
    Effect.gen(function* () {
      yield* createSubheadTestThread(head);
      const worker = ThreadId.make("queued-worker");
      yield* createSubheadTestThread(worker);
      const sql = yield* SqlClient.SqlClient;
      yield* writeMetadata(sql, { threadId: worker, parentThreadId: head });
      const threads = yield* Threads.ThreadManagementService;
      yield* sendSubheadTestMessage(worker);
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue"),
        messageId: MessageId.make("queue"),
        threadId: worker,
        text: "Queued",
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop"),
        threadId: worker,
      });
      const registry = yield* makeSubheadRegistry;
      yield* registry.create({ ...template, concurrency: 2 });
      yield* registry.setState("review", "enable");
      const runs = yield* makeSubheadRuns;
      const a = yield* runs.send(caller, { name: "review", requestId: "a", request: "A" });
      const b = yield* runs.send(caller, { name: "review", requestId: "b", request: "B" });
      const capacity = yield* makeSubheadCapacity;
      expect(yield* capacity.reserve(a.id)).toBe(true);
      expect(yield* capacity.reserve(b.id)).toBe(true);
      yield* threads.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-full"),
        threadId: worker,
      });
      expect(
        (yield* threads.getThreadRecords(worker, ["runs"])).runs.find(
          (run) => run.userMessageId === "queue",
        )?.status,
      ).toBe("queued");
      yield* (yield* AutomationStore).saveRun({
        ...a,
        status: "completed",
        finishedAt: a.createdAt,
      });
      yield* threads.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-free"),
        threadId: worker,
      });
      expect(
        (yield* threads.getThreadRecords(worker, ["runs"])).runs.find(
          (run) => run.userMessageId === "queue",
        )?.status,
      ).not.toBe("queued");
    }).pipe(Effect.provide(subheadNativeLayer)),
  );
  it.effect("ordinary turns and persisted virtual reservations share two slots", () =>
    Effect.gen(function* () {
      yield* createSubheadTestThread(head);
      const registry = yield* makeSubheadRegistry;
      yield* registry.create(template);
      yield* registry.setState("review", "enable");
      yield* registry.create({ ...template, name: "audit" });
      yield* registry.setState("audit", "enable");
      const sql = yield* SqlClient.SqlClient;
      const ordinary = ThreadId.make("ordinary");
      const third = ThreadId.make("third");
      for (const threadId of [ordinary, third]) {
        yield* createSubheadTestThread(threadId);
        yield* writeMetadata(sql, { threadId, parentThreadId: head });
      }
      yield* sendSubheadTestMessage(ordinary);
      const runs = yield* makeSubheadRuns;
      const a = yield* runs.send(caller, { name: "review", requestId: "a", request: "A" });
      const b = yield* runs.send(caller, { name: "audit", requestId: "b", request: "B" });
      const capacity = yield* makeSubheadCapacity;
      expect(yield* capacity.reserve(a.id)).toBe(true);
      expect(yield* capacity.reserve(b.id)).toBe(false);
      expect(yield* capacity.canStart(third)).toBe(false);
      yield* sendSubheadTestMessage(third);
      const threads = yield* Threads.ThreadManagementService;
      expect((yield* threads.getThreadRecords(third, ["runs"])).runs[0]?.status).toBe("queued");
      yield* (yield* AutomationStore).saveRun({
        ...a,
        status: "completed",
        finishedAt: a.createdAt,
      });
      yield* threads.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("third-resume"),
        threadId: third,
      });
      expect((yield* threads.getThreadRecords(third, ["runs"])).runs[0]?.status).not.toBe("queued");
    }).pipe(Effect.provide(subheadNativeLayer)),
  );
  it.effect("disabled and retired registries lift the head cap after active leases finish", () =>
    Effect.gen(function* () {
      yield* createSubheadTestThread(head);
      const sql = yield* SqlClient.SqlClient;
      for (const id of ["busy-a", "busy-b", "idle"]) {
        yield* createSubheadTestThread(ThreadId.make(id));
        yield* writeMetadata(sql, { threadId: ThreadId.make(id), parentThreadId: head });
      }
      yield* sendSubheadTestMessage(ThreadId.make("busy-a"));
      yield* sendSubheadTestMessage(ThreadId.make("busy-b"));
      const registry = yield* makeSubheadRegistry;
      yield* registry.create(template);
      yield* registry.setState("review", "enable");
      const capacity = yield* makeSubheadCapacity;
      expect(yield* capacity.canStart(ThreadId.make("idle"))).toBe(false);
      yield* sendSubheadTestMessage(ThreadId.make("idle"));
      expect(
        (yield* (yield* Threads.ThreadManagementService).getThreadRecords(ThreadId.make("idle"), [
          "runs",
        ])).runs[0]?.status,
      ).toBe("queued");
      yield* registry.setState("review", "disable");
      expect(yield* capacity.queuedPeers).toContain("idle");
      expect(yield* capacity.canStart(ThreadId.make("idle"))).toBe(true);
      yield* registry.setState("review", "retire");
      expect(yield* capacity.canStart(ThreadId.make("idle"))).toBe(true);
    }).pipe(Effect.provide(subheadNativeLayer)),
  );
  it.effect(
    "a helper's FIFO and concurrency lease survive disabled admission and restart reads",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeSubheadRegistry;
        yield* registry.create(template);
        yield* registry.setState("review", "enable");
        const runs = yield* makeSubheadRuns;
        const a = yield* runs.send(caller, { name: "review", requestId: "a", request: "A" });
        const b = yield* runs.send(caller, { name: "review", requestId: "b", request: "B" });
        const capacity = yield* makeSubheadCapacity;
        expect(yield* capacity.reserve(b.id)).toBe(false);
        expect(yield* capacity.reserve(a.id)).toBe(true);
        expect(yield* capacity.reserve(a.id)).toBe(true);
        expect(yield* capacity.reserve(b.id)).toBe(false);
        yield* registry.setState("review", "disable");
        expect(yield* capacity.reserve(a.id)).toBe(true);
        yield* (yield* AutomationStore).saveRun({
          ...a,
          status: "completed",
          finishedAt: a.createdAt,
        });
        expect(yield* capacity.reserve(b.id)).toBe(false);
      }).pipe(Effect.provide(subheadNativeLayer)),
  );
});
