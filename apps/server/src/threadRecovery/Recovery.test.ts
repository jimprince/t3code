import * as Context from "effect/Context";
import { hostReceiptDigest } from "./HostReceipt.ts";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MessageId,
  RunId,
  AuthOrchestrationOperateScope,
  type HandoverHostReceipt,
} from "@t3tools/contracts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import * as Reset from "./SessionResetService.ts";
import * as Hook from "./ProviderSessionResetHook.ts";
import * as Pending from "./PendingHumanRequests.ts";
import * as Handover from "./HandoverService.ts";
import { RecoveryAuthority } from "./RecoveryAuthority.ts";
import { HumanIngress } from "./HumanIngress.ts";
import { writeMetadata, readMetadata } from "../forkThreads/MetadataStore.ts";
import * as Dashboards from "../projectDashboard/ProjectDashboardStore.ts";
import {
  execute,
  seed,
  seedConversation,
  old,
  successor,
  sibling,
  run,
  thread,
  message,
  messageId,
  itemId,
  input,
  sessionId,
  admin,
  event,
  write,
  stores,
} from "./Recovery.testkit.ts";
it.live(
  "fences and terminalizes exact run before teardown; retry survives an incomplete hook and preserves human work/native ref",
  () => {
    let stopped = false;
    let hookCalls = 0;
    return execute(
      Effect.gen(function* () {
        yield* seed().pipe(Effect.provideService(HumanIngress, "Brad"));
        const resets = yield* Reset.SessionResetService;
        const store = yield* RecoveryStore.RecoveryStore;
        const pending = yield* Pending.PendingHumanRequests;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const hook: Context.Service.Shape<typeof Hook.ProviderSessionResetHook> = {
          reset: () =>
            Effect.gen(function* () {
              hookCalls++;
              const p = yield* projections
                .getThreadRecords(old, ["runs", "providerThreads"])
                .pipe(Effect.orDie);
              expect(p.runs[0]?.status).toBe("cancelled");
              expect(yield* store.generation(old)).toBe(1);
              return { isolation: "thread" as const, stopped };
            }),
        };
        yield* resets.reset(input).pipe(
          Effect.provideService(Hook.ProviderSessionResetHook, hook),
          Effect.flip,
          Effect.tap((e) => Effect.sync(() => expect(e.code).toBe("teardown"))),
        );
        const blocked = yield* write([
          event({ type: "run.updated", threadId: old, payload: run("running") }),
        ]).pipe(Effect.flip);
        expect(blocked._tag).toBe("EventSinkWriteError");
        stopped = true;
        const receipt = yield* resets
          .reset(input)
          .pipe(Effect.provideService(Hook.ProviderSessionResetHook, hook));
        expect(receipt.status).toBe("completed");
        expect(receipt.newGeneration).toBe(1);
        expect(yield* resets.reset(input)).toEqual(receipt);
        expect(hookCalls).toBe(2);
        expect(yield* pending.listPending({ threadId: old })).toEqual([
          { turnItemId: itemId, sourceMessageId: messageId, reason: "interrupted" },
        ]);
        const p = yield* ProjectionStore.ProjectionStoreV2.use((s) =>
          s.getThreadRecords(old, ["messages", "providerThreads"]),
        );
        expect(p.messages[0]?.text).toContain("Human request");
        expect(p.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("native-old");
        const reused = yield* resets
          .reset({ ...input, reason: "discard_native" })
          .pipe(Effect.flip);
        expect(reused.code).toBe("conflict");
        const stale = yield* resets.reset({ ...input, requestId: "reset-2" }).pipe(Effect.flip);
        expect(stale.code).toBe("conflict");
        const late = yield* EventSink.EventSinkV2.use((s) =>
          s.write({
            unlessSessionFenced: sessionId,
            events: [event({ type: "run.updated", threadId: old, payload: run("running") })],
          }),
        );
        expect(late).toEqual([]);
        const unrelated = yield* EventSink.EventSinkV2.use((s) =>
          s.write({
            unlessSessionFenced: sessionId,
            events: [
              event({
                type: "thread.metadata-updated",
                threadId: sibling,
                payload: { ...thread(sibling), title: "still usable" },
              }),
            ],
          }),
        );
        expect(unrelated).toHaveLength(1);
        const restarted = yield* Layer.build(RecoveryStore.layer.pipe(Layer.provide(stores)));
        expect(
          yield* RecoveryStore.RecoveryStore.use((s) => s.generation(old)).pipe(
            Effect.provide(restarted),
          ),
        ).toBe(1);
        const freshRunId = RunId.make("resumed-run");
        yield* write([
          event({
            type: "run.created",
            threadId: old,
            payload: { ...run("running"), id: freshRunId, ordinal: 2 },
          }),
        ]);
        const sink = yield* EventSink.EventSinkV2;
        const update = event({
          type: "message.updated",
          threadId: old,
          payload: {
            ...message(MessageId.make("resumed-answer")),
            runId: freshRunId,
            role: "assistant",
            createdBy: "agent",
            creationSource: "provider",
            text: "Resumed answer",
          },
        });
        expect(
          yield* sink.write({
            unlessSessionFenced: sessionId,
            sessionFenceRunId: freshRunId,
            events: [update],
          }),
        ).toHaveLength(1);
        expect(
          yield* sink.write({
            unlessSessionFenced: sessionId,
            sessionFenceRunId: input.runId,
            events: [update],
          }),
        ).toEqual([]);
        expect(
          yield* sink.write({
            unlessSessionFenced: sessionId,
            events: [event({ type: "run.updated", threadId: old, payload: run("running") })],
          }),
        ).toEqual([]);
        const records = yield* ProjectionStore.ProjectionStoreV2.use((s) =>
          s.getThreadRecords(old, ["runs", "messages"]),
        );
        expect(records.runs.find((r) => r.id === freshRunId)?.status).toBe("running");
        expect(records.messages.find((m) => m.id === update.payload.id)?.text).toBe(
          "Resumed answer",
        );
      }),
    );
  },
);

it.live(
  "a completed run without assistant output leaves its human request pending; automation and agent sends are excluded and explicit evidence resolves them",
  () => {
    return execute(
      Effect.gen(function* () {
        yield* seed("completed").pipe(Effect.provideService(HumanIngress, "Brad"));
        yield* write([
          event({
            type: "message.updated",
            threadId: old,
            payload: {
              ...message(MessageId.make("agent")),
              createdBy: "agent",
              creationSource: "mcp",
            },
          }),
          event({
            type: "message.updated",
            threadId: old,
            payload: {
              ...message(MessageId.make("notification")),
              createdBy: "system",
              creationSource: "server",
            },
          }),
        ]);
        const pending = yield* Pending.PendingHumanRequests;
        expect(yield* pending.listPending({ threadId: old })).toEqual([
          { turnItemId: itemId, sourceMessageId: messageId, reason: "unanswered" },
        ]);
        const result = yield* pending.read({ threadId: old });
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0]?.origin).toBe("human");
        const addressed = yield* pending.resolve({
          threadId: old,
          itemIds: [itemId],
          reference: "answer:explicit-human-source",
        });
        expect(addressed.requests).toEqual([]);
        expect(
          (yield* pending.resolve({
            threadId: old,
            itemIds: [itemId],
            reference: "answer:explicit-human-source",
          })).requests,
        ).toEqual([]);
        expect(
          (yield* pending
            .resolve({ threadId: old, itemIds: [itemId], reference: "different-evidence" })
            .pipe(Effect.flip)).code,
        ).toBe("conflict");
      }),
    );
  },
);

it.live(
  "standard credentials and runtime ceiling are refused before any reset mutation; discard detaches native reference",
  () => {
    return execute(
      Effect.gen(function* () {
        yield* seed();
        const reset = yield* Reset.SessionResetService;
        const store = yield* RecoveryStore.RecoveryStore;
        const denied = yield* reset.reset(input).pipe(
          Effect.provideService(RecoveryAuthority, {
            principal: "standard",
            scopes: [AuthOrchestrationOperateScope],
          }),
          Effect.flip,
        );
        expect(denied.code).toBe("forbidden");
        expect(yield* store.generation(old)).toBe(0);
        const ceiling = yield* reset.reset(input).pipe(
          Effect.provideService(RecoveryAuthority, {
            ...admin,
            runtimeModeCeiling: "approval-required",
          }),
          Effect.flip,
        );
        expect(ceiling.code).toBe("forbidden");
        const newerId = RunId.make("newer-cancelled-attached");
        yield* write([
          event({
            type: "run.created",
            threadId: old,
            payload: {
              ...run("cancelled"),
              id: newerId,
              ordinal: 2,
            },
          }),
        ]);
        const superseded = yield* reset.reset(input).pipe(Effect.flip);
        expect(superseded.code).toBe("conflict");
        expect(yield* store.generation(old)).toBe(0);
        // A cancelled request that never attached may coexist with the original live run.
        yield* write([
          event({
            type: "run.updated",
            threadId: old,
            payload: {
              ...run("cancelled"),
              id: newerId,
              ordinal: 2,
              providerThreadId: null,
              startedAt: null,
            },
          }),
        ]);
        yield* reset.reset({ ...input, reason: "discard_native" }).pipe(
          Effect.provideService(Hook.ProviderSessionResetHook, {
            reset: () => Effect.succeed({ isolation: "thread", stopped: true }),
          }),
        );
        const p = yield* ProjectionStore.ProjectionStoreV2.use((s) =>
          s.getThreadRecords(old, ["providerThreads", "messages"]),
        );
        expect(p.providerThreads[0]?.nativeThreadRef).toBeNull();
        expect(p.messages[0]?.id).toBe(messageId);
      }),
    );
  },
);

const host = (transferId: string, environment: string): HandoverHostReceipt => {
  const receipt: HandoverHostReceipt = {
    transferId,
    environment,
    oldThreadId: old,
    successorThreadId: successor,
    oldGeneration: 0,
    newGeneration: 1,
    digest: "",
    items: [],
    principal: "host-admin",
  };
  return { ...receipt, digest: hostReceiptDigest(receipt) };
};
it.live(
  "handover waits for both hosts, then transfers children/layout/automation/pin and settles unarchived source; duplicate is stable",
  () => {
    return execute(
      Effect.gen(function* () {
        yield* seed("completed");
        const sql = yield* SqlClient.SqlClient;
        yield* writeMetadata(sql, {
          threadId: sibling,
          parentThreadId: old,
          settleOnComplete: true,
        });
        const dashboards = yield* Dashboards.make;
        yield* dashboards.modify((file) => ({
          ...file,
          layouts: { [old]: { history: [{ rootThreadId: old, revision: 3, tabs: [] }] } },
          dashboards: { [old]: { widgets: ["tasks"] } },
          health: { [old]: { text: "Healthy" } },
        }));
        const automation = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          id: "auto",
          projectId: "project",
          ownerThreadId: old,
          actions: [
            {
              type: "agent",
              prompt: "do work",
              target: { kind: "existing-thread", threadId: old },
            },
          ],
        });
        yield* sql`INSERT INTO automations(automation_id,project_id,automation_json,created_at,updated_at) VALUES('auto','project',${automation},'now','now')`;
        const handover = yield* Handover.HandoverService;
        const input = {
          oldThreadId: old,
          successorThreadId: successor,
          expectedGeneration: 0,
          requestId: "handover-1",
          reason: "watchdog",
          requiredEnvironments: ["dev", "mac"],
        };
        const prepared = yield* handover.prepare(input);
        expect(yield* handover.prepare(input)).toEqual(prepared);
        const pending = yield* handover.commit({
          transferId: prepared.transferId,
          requestId: "commit-1",
          hostReceipts: [host(prepared.transferId, "dev")],
        });
        expect(pending.status).toBe("pending-host");
        expect(
          (yield* ProjectionStore.ProjectionStoreV2.use((s) => s.getThreadRecords(old, []))).thread
            .settledOverride,
        ).toBeNull();
        const finished = yield* handover.commit({
          transferId: prepared.transferId,
          requestId: "commit-2",
          hostReceipts: [host(prepared.transferId, "mac")],
        });
        expect(finished.status).toBe("completed");
        expect(
          yield* handover.commit({
            transferId: prepared.transferId,
            requestId: "commit-2",
            hostReceipts: [host(prepared.transferId, "mac")],
          }),
        ).toEqual(finished);
        expect((yield* readMetadata(sql, sibling))?.parentThreadId).toBe(successor);
        const p = yield* ProjectionStore.ProjectionStoreV2.use((s) =>
          s.getThreadRecords(old, ["messages"]),
        );
        expect(p.thread.settledOverride).toBe("settled");
        expect(p.thread.archivedAt).toBeNull();
        expect(p.messages).toHaveLength(1);
        const replacement = (yield* ProjectionStore.ProjectionStoreV2.use((s) =>
          s.getThreadRecords(successor, []),
        )).thread;
        expect(replacement.pinOrderKey).toBe("a0");
        expect(replacement.autoSettleDisabledAt).not.toBeNull();
        expect(replacement.settledOverride).toBe("active");
        expect((yield* dashboards.read).layouts[successor]?.history[0]).toMatchObject({
          rootThreadId: successor,
          revision: 3,
        });
        const autos = yield* sql<{
          json: string;
        }>`SELECT automation_json AS json FROM automations WHERE automation_id='auto'`;
        expect(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(autos[0]!.json),
        ).toMatchObject({
          ownerThreadId: successor,
          actions: [{ target: { threadId: successor } }],
        });
        const refused = yield* write([
          event({
            type: "message.updated",
            threadId: old,
            payload: message(MessageId.make("late")),
          }),
        ]).pipe(Effect.flip);
        expect(refused._tag).toBe("EventSinkWriteError");
      }),
    );
  },
);

it.live(
  "unsupported reset stays fenced; user edits preserve the ingress principal and unknown historical provenance",
  () => {
    return execute(
      Effect.gen(function* () {
        yield* seed().pipe(Effect.provideService(HumanIngress, "Brad"));
        const failed = yield* Reset.SessionResetService.use((s) => s.reset(input)).pipe(
          Effect.flip,
        );
        expect(failed.code).toBe("unsupported");
        expect(yield* RecoveryStore.RecoveryStore.use((s) => s.generation(old))).toBe(1);
        yield* write([
          event({
            type: "message.updated",
            threadId: old,
            payload: { ...message(messageId), text: "Edited question" },
          }),
        ]).pipe(Effect.provideService(HumanIngress, "editor"));
        const p = yield* ProjectionStore.ProjectionStoreV2.use((s) =>
          s.getThreadRecords(old, ["messages"]),
        );
        expect(p.messages[0]?.humanOrigin?.principal).toBe("Brad");
        const historical = MessageId.make("historical");
        yield* write([
          event({ type: "message.updated", threadId: old, payload: message(historical) }),
        ]);
        yield* write([
          event({
            type: "message.updated",
            threadId: old,
            payload: { ...message(historical), text: "Edited old message" },
          }),
        ]).pipe(Effect.provideService(HumanIngress, "editor"));
        const pending = yield* Pending.PendingHumanRequests.use((s) => s.read({ threadId: old }));
        expect(pending.requests.find((r) => r.messageId === historical)?.origin).toBe("unknown");
      }),
    );
  },
);

it.live(
  "handover resumes across persisted host receipts and an already moved dashboard, while rejecting newer edits",
  () => {
    return execute(
      Effect.gen(function* () {
        yield* seed("completed");
        const sql = yield* SqlClient.SqlClient;
        yield* writeMetadata(sql, {
          threadId: sibling,
          parentThreadId: old,
          settleOnComplete: true,
        });
        const dashboard = yield* Dashboards.make;
        yield* dashboard.modify((file) => ({
          ...file,
          dashboards: { [old]: { widgets: ["tasks"] } },
        }));
        const service = yield* Handover.HandoverService;
        const receipt = yield* service.prepare({
          oldThreadId: old,
          successorThreadId: successor,
          expectedGeneration: 0,
          requestId: "crash",
          reason: "operator",
          requiredEnvironments: ["dev", "mac"],
        });
        const commit = {
          transferId: receipt.transferId,
          requestId: "commit-crash",
          hostReceipts: [host(receipt.transferId, "dev"), host(receipt.transferId, "mac")],
        };
        const previous = process.env.T3CODE_TEST_FAULTS;
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.T3CODE_TEST_FAULTS;
            else process.env.T3CODE_TEST_FAULTS = previous;
          }),
        );
        for (const point of ["handover-after-hosts", "handover-after-dashboard"]) {
          process.env.T3CODE_TEST_FAULTS = point;
          expect((yield* service.commit(commit).pipe(Effect.flip)).code).toBe("pending");
          expect(
            (yield* service.status({ transferId: receipt.transferId })).hostReceipts,
          ).toHaveLength(2);
          expect(
            (yield* ProjectionStore.ProjectionStoreV2.use((s) => s.getThreadRecords(old, [])))
              .thread.settledOverride,
          ).toBeNull();
          expect((yield* readMetadata(sql, sibling))?.parentThreadId).toBe(old);
        }
        expect((yield* dashboard.read).dashboards[successor]?.widgets).toEqual(["tasks"]);
        delete process.env.T3CODE_TEST_FAULTS;
        expect((yield* service.commit(commit)).status).toBe("completed");
        expect((yield* readMetadata(sql, sibling))?.parentThreadId).toBe(successor);
        yield* dashboard.modify((file) => ({
          ...file,
          dashboards: { ...file.dashboards, [successor]: { widgets: ["decisions"] } },
        }));
        expect((yield* service.commit(commit).pipe(Effect.flip)).code).toBe("conflict");
        expect((yield* dashboard.read).dashboards[successor]?.widgets).toEqual(["decisions"]);
      }),
    );
  },
);

it.live(
  "queued human messages without turn items use allocator IDs and remain pending until explicitly answered",
  () =>
    execute(
      Effect.gen(function* () {
        yield* seed("queued").pipe(Effect.provideService(HumanIngress, "Brad"));
        const queuedMessageId = MessageId.make("queued-human-without-item");
        yield* write([
          event({ type: "message.updated", threadId: old, payload: message(queuedMessageId) }),
        ]).pipe(Effect.provideService(HumanIngress, "Brad"));
        const pending = yield* Pending.PendingHumanRequests;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const queuedItemId = ids.derive.userTurnItem({ messageId: queuedMessageId });
        expect(queuedItemId).not.toBe(queuedMessageId);
        expect(yield* pending.listPending({ threadId: old })).toEqual([
          { turnItemId: itemId, sourceMessageId: messageId, reason: "queued" },
          { turnItemId: queuedItemId, sourceMessageId: queuedMessageId, reason: "queued" },
        ]);
        yield* write([
          event({
            type: "message.updated",
            threadId: old,
            payload: {
              ...message(MessageId.make("explicit-answer")),
              role: "assistant",
              createdBy: "agent",
              creationSource: "provider",
              addressedRequestIds: [messageId],
            },
          }),
        ]);
        expect(yield* pending.listPending({ threadId: old })).toEqual([
          { turnItemId: queuedItemId, sourceMessageId: queuedMessageId, reason: "queued" },
        ]);
        expect(
          (yield* pending.resolve({
            threadId: old,
            itemIds: [queuedItemId],
            reference: "answer:queued",
          })).requests,
        ).toEqual([]);
      }),
    ),
);

it.live(
  "a later completed assistant reply answers earlier requests; failed, interrupted, queued and newest requests stay pending",
  () =>
    execute(
      Effect.gen(function* () {
        yield* seed("completed").pipe(Effect.provideService(HumanIngress, "Brad"));
        yield* seedConversation(30, { 12: "interrupted", 20: "failed", 30: "queued" });
        const pending = yield* Pending.PendingHumanRequests;
        // The seeded run-old request (ordinal 1) is answered by later replies.
        expect(yield* pending.listPending({ threadId: old })).toEqual([
          {
            turnItemId: "item-human-12",
            sourceMessageId: "human-12",
            reason: "interrupted",
          },
          { turnItemId: "item-human-20", sourceMessageId: "human-20", reason: "failed" },
          { turnItemId: "item-human-30", sourceMessageId: "human-30", reason: "queued" },
        ]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fork_recovery_human_dispositions(message_id,thread_id,disposition,principal,reference) VALUES('human-5',${old},'unanswered','Brad','still-open')`;
        expect(
          (yield* pending.listPending({ threadId: old })).map((r) => r.sourceMessageId),
        ).toEqual(["human-5", "human-12", "human-20", "human-30"]);
      }),
    ),
);
