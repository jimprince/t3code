import { hostReceiptDigest } from "./HostReceipt.ts";
import {
  CommandId,
  EventId,
  ThreadId,
  HandoverPrepareInput,
  HandoverCommitInput,
  HandoverReceipt,
  ThreadRecoveryError,
  type HandoverItemReceipt,
  ForkThreadMetadata,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerConfig from "../config.ts";
import * as DashboardStore from "../projectDashboard/ProjectDashboardStore.ts";
import { listMetadata, readMetadata, writeMetadata } from "../forkThreads/MetadataStore.ts";
import { withOwnershipLock } from "../forkThreads/NamedAgentPolicy.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import * as PendingHuman from "./PendingHumanRequests.ts";
import { requireAdmin, RecoveryAuthority, assertWithinCeiling } from "./RecoveryAuthority.ts";

const fail = (cause: unknown) =>
  Schema.is(ThreadRecoveryError)(cause)
    ? cause
    : new ThreadRecoveryError({
        code: "storage",
        message: "Handover could not commit; retry the same operation after inspecting its status.",
      });
const conflict = (message: string) => new ThreadRecoveryError({ code: "conflict", message });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decoded = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const controls = (thread: {
  pinnedAt?: DateTime.Utc | null | undefined;
  pinOrderKey?: string | null | undefined;
  activeOrderKey?: string | null | undefined;
  autoSettleDisabledAt?: DateTime.Utc | null | undefined;
  settledOverride: string | null;
  settledAt: DateTime.Utc | null;
}) => ({
  pinnedAt: thread.pinnedAt ? DateTime.formatIso(thread.pinnedAt) : null,
  pinOrderKey: thread.pinOrderKey ?? null,
  activeOrderKey: thread.activeOrderKey ?? null,
  autoSettleDisabledAt: thread.autoSettleDisabledAt
    ? DateTime.formatIso(thread.autoSettleDisabledAt)
    : null,
  settledOverride: thread.settledOverride,
  settledAt: thread.settledAt ? DateTime.formatIso(thread.settledAt) : null,
});
const planSchema = Schema.Struct({
  receipt: HandoverReceipt,
  oldControls: Schema.Unknown,
  successorControls: Schema.Unknown,
  metadata: Schema.Array(
    Schema.Struct({ id: ThreadId, before: Schema.String, after: Schema.String }),
  ),
  automations: Schema.Array(
    Schema.Struct({ id: Schema.String, before: Schema.String, after: Schema.String }),
  ),
  dashboardBefore: Schema.Unknown,
  dashboardAfter: Schema.Unknown,
});
type Plan = typeof planSchema.Type;
/** A prepared source fence survives partial host transfer; old settlement requires all declared host receipts. */
// @effect-diagnostics-next-line leakingRequirements:off -- Authenticated authority is scoped to each call, never captured by the server layer.
export class HandoverService extends Context.Service<
  HandoverService,
  {
    readonly prepare: (
      input: typeof HandoverPrepareInput.Type,
    ) => Effect.Effect<HandoverReceipt, ThreadRecoveryError, RecoveryAuthority>;
    readonly commit: (
      input: typeof HandoverCommitInput.Type,
    ) => Effect.Effect<HandoverReceipt, ThreadRecoveryError, RecoveryAuthority>;
    readonly status: (input: {
      readonly transferId: string;
    }) => Effect.Effect<HandoverReceipt, ThreadRecoveryError, RecoveryAuthority>;
  }
>()("t3/threadRecovery/HandoverService") {}
const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* RecoveryStore.RecoveryStore;
  const human = yield* PendingHuman.PendingHumanRequests;
  const dashboards = yield* DashboardStore.make;
  const config = yield* ServerConfig.ServerConfig;
  const lockAll = <A, E, R>(
    ids: readonly ThreadId[],
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    [...new Set(ids)].sort().reduceRight((next, id) => locks.withLock(id, next), effect);
  const load = (transferId: string, principal: string) =>
    Effect.gen(function* () {
      const operation = yield* store.get(transferId);
      if (!operation)
        return yield* new ThreadRecoveryError({
          code: "not_found",
          message: "Handover intent was not found.",
        });
      if (operation.principal !== principal)
        return yield* new ThreadRecoveryError({
          code: "forbidden",
          message: "Handover belongs to a different authenticated principal.",
        });
      const plan = yield* Schema.decodeUnknownEffect(planSchema)(operation.payload);
      return { operation, plan };
    });
  const assertPair = (
    oldThread: ThreadManagement.ThreadManagementSendResult["projection"]["thread"],
    successor: typeof oldThread,
    authority: RecoveryAuthority["Service"],
  ) =>
    Effect.gen(function* () {
      if (
        oldThread.id === successor.id ||
        oldThread.projectId !== successor.projectId ||
        oldThread.deletedAt ||
        successor.deletedAt ||
        oldThread.archivedAt ||
        successor.archivedAt
      )
        return yield* conflict(
          "Live source and successor must be distinct threads in the same project.",
        );
      yield* assertWithinCeiling(authority, oldThread.runtimeMode);
      yield* assertWithinCeiling(authority, successor.runtimeMode);
      yield* assertWithinCeiling(
        { ...authority, runtimeModeCeiling: oldThread.runtimeMode },
        successor.runtimeMode,
      );
      const metadata = yield* listMetadata(sql);
      const seen = new Set<ThreadId>();
      let cursor: ThreadId | null = successor.id;
      while (cursor !== null) {
        if (cursor === oldThread.id || seen.has(cursor))
          return yield* conflict(
            "Successor cannot be a descendant of the source or participate in a cycle.",
          );
        seen.add(cursor);
        cursor = metadata.find((m) => m.threadId === cursor)?.parentThreadId ?? null;
      }
    });
  const status: HandoverService["Service"]["status"] = (input) =>
    Effect.gen(function* () {
      const authority = yield* requireAdmin;
      return (yield* load(input.transferId, authority.principal)).plan.receipt;
    }).pipe(Effect.mapError(fail));
  const prepare: HandoverService["Service"]["prepare"] = (raw) =>
    Effect.gen(function* () {
      const authority = yield* requireAdmin;
      const input = yield* Schema.decodeUnknownEffect(HandoverPrepareInput)(raw);
      if (
        new Set(input.requiredEnvironments).size !== input.requiredEnvironments.length ||
        input.requiredEnvironments.some((e) => !e.trim())
      )
        return yield* conflict("Required environment UUIDs must be nonempty and unique.");
      const transferId = `handover:${authority.principal}:${input.requestId}`;
      const fingerprint = encoded(input);
      return yield* withOwnershipLock(
        sql,
        lockAll(
          [input.oldThreadId, input.successorThreadId],
          store.transaction(
            Effect.gen(function* () {
              const existing = yield* store.get(transferId);
              if (existing) {
                if (existing.fingerprint !== fingerprint)
                  return yield* conflict("Request ID already identifies another handover.");
                return (yield* load(transferId, authority.principal)).plan.receipt;
              }
              const old = yield* threads.getThreadRecords(input.oldThreadId, ["runs"]);
              const successor = yield* threads.getThreadRecords(input.successorThreadId, []);
              yield* assertPair(old.thread, successor.thread, authority);
              if (
                old.runs.some((r) =>
                  ["preparing", "starting", "running", "waiting"].includes(r.status),
                )
              )
                return yield* new ThreadRecoveryError({
                  code: "pending",
                  message: "Reset or terminalize the exact old run before preparing its handover.",
                });
              const now = yield* DateTime.now;
              const allMetadata = yield* listMetadata(sql);
              const successorMeta = allMetadata.find(
                (m) => m.threadId === input.successorThreadId,
              ) ?? { threadId: input.successorThreadId, parentThreadId: null };
              const oldMeta = allMetadata.find((m) => m.threadId === input.oldThreadId) ?? {
                threadId: input.oldThreadId,
                parentThreadId: null,
              };
              const metadata = allMetadata
                .filter((m) => m.parentThreadId === input.oldThreadId)
                .map((m) => ({
                  id: m.threadId,
                  before: encoded(m),
                  after: encoded({ ...m, parentThreadId: input.successorThreadId }),
                }));
              metadata.push({
                id: input.successorThreadId,
                before: encoded(successorMeta),
                after: encoded({ ...successorMeta, settleOnComplete: false }),
              });
              if (
                successorMeta.parentThreadId !== oldMeta.parentThreadId ||
                successorMeta.remoteParent
              )
                return yield* conflict("Successor must share the source's organizational parent.");
              const rows = yield* sql<{
                id: string;
                json: string;
              }>`SELECT automation_id AS id,automation_json AS json FROM automations WHERE deleted_at IS NULL`;
              const automations = [];
              for (const row of rows) {
                const raw = yield* decoded(row.json);
                if (!object(raw)) return yield* conflict("Invalid automation inventory.");
                const actions = Array.isArray(raw.actions) ? raw.actions : [];
                const next = {
                  ...raw,
                  ...(raw.ownerThreadId === input.oldThreadId
                    ? { ownerThreadId: input.successorThreadId }
                    : {}),
                  actions: actions.map((a) =>
                    object(a) &&
                    object(a.target) &&
                    a.target.kind === "existing-thread" &&
                    a.target.threadId === input.oldThreadId
                      ? { ...a, target: { ...a.target, threadId: input.successorThreadId } }
                      : a,
                  ),
                };
                if (!same(raw, next))
                  automations.push({ id: row.id, before: row.json, after: encoded(next) });
              }
              const file = yield* dashboards.read;
              const dashboardBefore = {
                layouts: file.layouts[input.oldThreadId] ?? null,
                dashboards: file.dashboards[input.oldThreadId] ?? null,
                health: file.health[input.oldThreadId] ?? null,
              };
              if (
                file.layouts[input.successorThreadId] ||
                file.dashboards[input.successorThreadId] ||
                file.health[input.successorThreadId]
              )
                return yield* conflict(
                  "Successor already has dashboard state; reconcile it before handover.",
                );
              const rewrite = (v: unknown) =>
                object(v)
                  ? {
                      ...v,
                      ...("rootThreadId" in v ? { rootThreadId: input.successorThreadId } : {}),
                    }
                  : v;
              const dashboardAfter = {
                ...dashboardBefore,
                layouts: dashboardBefore.layouts
                  ? { history: dashboardBefore.layouts.history.map(rewrite) }
                  : null,
              };
              const newGeneration = yield* store.advance(
                input.oldThreadId,
                input.expectedGeneration,
              );
              const pending = yield* human.read({ threadId: input.oldThreadId });
              const receipt: HandoverReceipt = {
                transferId,
                requestId: input.requestId,
                oldThreadId: input.oldThreadId,
                successorThreadId: input.successorThreadId,
                oldGeneration: input.expectedGeneration,
                newGeneration,
                status: "prepared",
                requiredEnvironments: input.requiredEnvironments,
                hostReceipts: [],
                items: [],
                watermark: pending.watermark,
                principal: authority.principal,
              };
              const plan: Plan = {
                receipt,
                oldControls: controls(old.thread),
                successorControls: controls(successor.thread),
                metadata,
                automations,
                dashboardBefore,
                dashboardAfter,
              };
              yield* store.save(transferId, authority.principal, fingerprint, plan);
              yield* sql`INSERT INTO fork_recovery_thread_fences(thread_id,successor_thread_id,operation_id) VALUES(${input.oldThreadId},${input.successorThreadId},${transferId})`;
              // Capture timestamp as audit data without changing visible lifecycle yet.
              yield* Effect.annotateCurrentSpan({
                "handover.prepared_at": DateTime.formatIso(now),
              });
              return receipt;
            }),
          ),
        ),
      );
    }).pipe(Effect.mapError(fail));
  const commit: HandoverService["Service"]["commit"] = (raw) =>
    Effect.gen(function* () {
      const authority = yield* requireAdmin;
      const input = yield* Schema.decodeUnknownEffect(HandoverCommitInput)(raw);
      const initial = yield* load(input.transferId, authority.principal);
      const id = initial.plan.receipt.oldThreadId;
      return yield* withOwnershipLock(
        sql,
        lockAll(
          [id, initial.plan.receipt.successorThreadId, ...initial.plan.metadata.map((m) => m.id)],
          Effect.gen(function* () {
            const { operation, plan } = yield* load(input.transferId, authority.principal);
            const r = plan.receipt;
            const commitId = `handover-commit:${authority.principal}:${input.requestId}`;
            const previousCommit = yield* store.get(commitId);
            const commitFingerprint = encoded(input);
            if (previousCommit && previousCommit.fingerprint !== commitFingerprint)
              return yield* conflict("Commit request ID already identifies a different payload.");
            if (!previousCommit)
              yield* store.save(commitId, authority.principal, commitFingerprint, {
                transferId: input.transferId,
              });
            if (r.status === "completed") {
              const oldNow = yield* threads.getThreadRecords(r.oldThreadId, []);
              const newNow = yield* threads.getThreadRecords(r.successorThreadId, []);
              if (
                oldNow.thread.settledOverride !== "settled" ||
                oldNow.thread.archivedAt !== null ||
                newNow.thread.settledOverride !== "active" ||
                !newNow.thread.autoSettleDisabledAt
              )
                return yield* conflict(
                  "Completed lifecycle readback changed; reconcile newer edits explicitly.",
                );
              for (const m of plan.metadata) {
                if (encoded(yield* readMetadata(sql, m.id)) !== m.after)
                  return yield* conflict(
                    "Completed organization changed; retry did not overwrite newer edits.",
                  );
              }
              for (const automation of plan.automations) {
                const rows = yield* sql<{
                  payload: string;
                }>`SELECT automation_json AS payload FROM automations WHERE automation_id=${automation.id} AND deleted_at IS NULL`;
                if (rows[0]?.payload !== automation.after)
                  return yield* conflict(
                    "Completed automation target changed; retry did not overwrite newer edits.",
                  );
              }
              const file = yield* dashboards.read;
              if (
                file.layouts[r.oldThreadId] ||
                file.dashboards[r.oldThreadId] ||
                file.health[r.oldThreadId]
              )
                return yield* conflict(
                  "Completed source dashboard state reappeared; reconcile explicitly.",
                );
              const desired = {
                layouts: file.layouts[r.successorThreadId] ?? null,
                dashboards: file.dashboards[r.successorThreadId] ?? null,
                health: file.health[r.successorThreadId] ?? null,
              };
              if (!same(desired, plan.dashboardAfter))
                return yield* conflict(
                  "Completed dashboard state changed; retry did not overwrite newer edits.",
                );
              return r;
            }
            if ((yield* store.generation(id)) !== r.newGeneration)
              return yield* conflict("Source generation changed after handover preparation.");
            const hosts = new Map(r.hostReceipts.map((h) => [h.environment, h]));
            for (const h of input.hostReceipts) {
              if (
                h.transferId !== r.transferId ||
                h.oldThreadId !== r.oldThreadId ||
                h.successorThreadId !== r.successorThreadId ||
                !r.requiredEnvironments.includes(h.environment) ||
                h.newGeneration !== h.oldGeneration + 1 ||
                h.digest !== hostReceiptDigest(h)
              )
                return yield* conflict("Host receipt does not match this prepared handover.");
              const previous = hosts.get(h.environment);
              if (previous && !same(previous, h))
                return yield* conflict(
                  "A different receipt already identifies this host transfer.",
                );
              hosts.set(h.environment, h);
            }
            const missing = r.requiredEnvironments.some((e) => !hosts.has(e));
            const receipt: HandoverReceipt = {
              ...r,
              hostReceipts: [...hosts.values()],
              status: missing ? "pending-host" : "committing",
            };
            yield* store.save(r.transferId, authority.principal, operation.fingerprint, {
              ...plan,
              receipt,
            });
            if (missing) return receipt;
            if (
              config.devUrl &&
              !config.staticDir &&
              process.env.T3CODE_TEST_FAULTS === "handover-after-hosts"
            )
              return yield* new ThreadRecoveryError({
                code: "pending",
                message: "Isolated test fault after host receipts; retry without the fault flag.",
              });
            const old = yield* threads.getThreadRecords(r.oldThreadId, ["runs"]);
            const successor = yield* threads.getThreadRecords(r.successorThreadId, []);
            yield* assertPair(old.thread, successor.thread, authority);
            if (
              !same(controls(old.thread), plan.oldControls) ||
              !same(controls(successor.thread), plan.successorControls)
            )
              return yield* conflict(
                "Thread lifecycle/pin/order was edited after preparation; preserve those edits and reconcile.",
              );
            if (
              old.runs.some((run) =>
                ["preparing", "starting", "running", "waiting"].includes(run.status),
              )
            )
              return yield* conflict("Old run became active; reset it before commit.");
            let dashboardError = false;
            yield* dashboards.modify((file) => {
              const before = {
                layouts: file.layouts[r.oldThreadId] ?? null,
                dashboards: file.dashboards[r.oldThreadId] ?? null,
                health: file.health[r.oldThreadId] ?? null,
              };
              const after = {
                layouts: file.layouts[r.successorThreadId] ?? null,
                dashboards: file.dashboards[r.successorThreadId] ?? null,
                health: file.health[r.successorThreadId] ?? null,
              };
              if (
                same(before, { layouts: null, dashboards: null, health: null }) &&
                same(after, plan.dashboardAfter)
              )
                return file;
              if (
                !same(before, plan.dashboardBefore) ||
                !same(after, { layouts: null, dashboards: null, health: null })
              ) {
                dashboardError = true;
                return file;
              }
              const layouts = { ...file.layouts },
                dashboards = { ...file.dashboards },
                health = { ...file.health };
              const target = plan.dashboardAfter;
              if (!object(target)) {
                dashboardError = true;
                return file;
              }
              if (object(target.layouts) && Array.isArray(target.layouts.history))
                layouts[r.successorThreadId] = { history: target.layouts.history };
              if (
                object(target.dashboards) &&
                Array.isArray(target.dashboards.widgets) &&
                target.dashboards.widgets.every((w) => typeof w === "string")
              )
                dashboards[r.successorThreadId] = { widgets: target.dashboards.widgets };
              if (target.health !== null) health[r.successorThreadId] = target.health;
              delete layouts[r.oldThreadId];
              delete dashboards[r.oldThreadId];
              delete health[r.oldThreadId];
              return { ...file, layouts, dashboards, health };
            });
            if (dashboardError)
              return yield* conflict(
                "Dashboard revision changed; transfer did not overwrite either layout.",
              );
            if (
              config.devUrl &&
              !config.staticDir &&
              process.env.T3CODE_TEST_FAULTS === "handover-after-dashboard"
            )
              return yield* new ThreadRecoveryError({
                code: "pending",
                message:
                  "Isolated test fault after dashboard transfer; retry without the fault flag.",
              });
            return yield* store.transaction(
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                const items: HandoverItemReceipt[] = [
                  ...receipt.hostReceipts.flatMap((h) => h.items),
                  {
                    kind: "layout",
                    id: r.oldThreadId,
                    before: plan.dashboardBefore,
                    after: plan.dashboardAfter,
                    principal: authority.principal,
                  },
                ];
                const events: OrchestrationV2DomainEvent[] = [];
                for (const m of plan.metadata) {
                  const current = yield* readMetadata(sql, m.id);
                  const before = encoded(current ?? { threadId: m.id, parentThreadId: null });
                  if (before !== m.before)
                    return yield* conflict(
                      "Child or successor organization changed after preparation.",
                    );
                  const next = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(ForkThreadMetadata),
                  )(m.after);
                  yield* writeMetadata(sql, next);
                  const p = yield* threads.getThreadRecords(m.id, []);
                  events.push({
                    id: EventId.make(`${r.transferId}:metadata:${m.id}`),
                    threadId: m.id,
                    occurredAt: now,
                    type: "thread.metadata-updated",
                    payload: {
                      ...p.thread,
                      forkMetadataRevision: (p.thread.forkMetadataRevision ?? 0) + 1,
                    },
                  });
                  items.push({
                    kind: m.id === r.successorThreadId ? "lifecycle" : "child",
                    id: m.id,
                    before: current ?? null,
                    after: next,
                    principal: authority.principal,
                  });
                }
                for (const a of plan.automations) {
                  const current = yield* sql<{
                    json: string;
                  }>`SELECT automation_json AS json FROM automations WHERE automation_id=${a.id} AND deleted_at IS NULL`;
                  if (current[0]?.json !== a.before)
                    return yield* conflict(
                      "Automation changed after preparation; no owner/action edit was overwritten.",
                    );
                  yield* sql`UPDATE automations SET automation_json=${a.after} WHERE automation_id=${a.id} AND automation_json=${a.before}`;
                  items.push({
                    kind: "automation",
                    id: a.id,
                    before: yield* decoded(a.before),
                    after: yield* decoded(a.after),
                    principal: authority.principal,
                  });
                }
                const oldAfter = {
                  ...old.thread,
                  pinnedAt: null,
                  pinOrderKey: null,
                  activeOrderKey: null,
                  settledOverride: "settled" as const,
                  settledAt: now,
                  autoSettleDisabledAt: null,
                  updatedAt: now,
                };
                const successorAfter = {
                  ...successor.thread,
                  pinnedAt: old.thread.pinnedAt ?? null,
                  pinOrderKey: old.thread.pinOrderKey ?? null,
                  activeOrderKey: old.thread.activeOrderKey ?? null,
                  autoSettleDisabledAt: now,
                  settledOverride: "active" as const,
                  settledAt: null,
                  unsettledAt: now,
                  updatedAt: now,
                  forkMetadataRevision: (successor.thread.forkMetadataRevision ?? 0) + 1,
                };
                events.push(
                  {
                    id: EventId.make(`${r.transferId}:old`),
                    threadId: r.oldThreadId,
                    occurredAt: now,
                    type: "thread.metadata-updated",
                    payload: oldAfter,
                  },
                  {
                    id: EventId.make(`${r.transferId}:successor`),
                    threadId: r.successorThreadId,
                    occurredAt: now,
                    type: "thread.metadata-updated",
                    payload: successorAfter,
                  },
                );
                yield* sink.write({ commandId: CommandId.make(r.transferId), events });
                items.push(
                  {
                    kind: "pin",
                    id: r.successorThreadId,
                    before: plan.successorControls,
                    after: controls(successorAfter),
                    principal: authority.principal,
                  },
                  {
                    kind: "lifecycle",
                    id: r.oldThreadId,
                    before: plan.oldControls,
                    after: controls(oldAfter),
                    principal: authority.principal,
                  },
                );
                const completed: HandoverReceipt = { ...receipt, status: "completed", items };
                yield* store.save(r.transferId, authority.principal, operation.fingerprint, {
                  ...plan,
                  receipt: completed,
                });
                return completed;
              }),
            );
          }),
        ),
      );
    }).pipe(Effect.mapError(fail));
  return HandoverService.of({ prepare, commit, status });
});
export const layer = Layer.effect(HandoverService, make);
