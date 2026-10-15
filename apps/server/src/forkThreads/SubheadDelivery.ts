import {
  NamedAgentError,
  CommandId,
  type AutomationRun,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { AutomationStore } from "../automations/AutomationStore.ts";
import { inputRootRun } from "../automations/runOutcome.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { makeHandoffService } from "./HandoffService.ts";
import { readMetadata, writeMetadata } from "./MetadataStore.ts";
import { withOwnershipLock } from "./NamedAgentPolicy.ts";
import { hasActiveWork } from "./ArchiveDeadlines.ts";
import { hasLiveChildren } from "./WorkerLifecycleMetadata.ts";

const isNamedAgentError = Schema.is(NamedAgentError);
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const locks = new WeakMap<SqlClient.SqlClient, Semaphore.Semaphore>();
const failure = (cause: unknown) =>
  isNamedAgentError(cause) ? cause : new NamedAgentError({ message: String(cause) });

/** The existing handoff journal atomically binds the delivery to its native message and wake. */
export const makeSubheadDelivery = (providers: Effect.Effect<ReadonlyArray<ServerProvider>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* AutomationStore;
    const threads = yield* Threads.ThreadManagementService;
    const lock = locks.get(sql) ?? Semaphore.makeUnsafe(1);
    locks.set(sql, lock);
    const handoffs = makeHandoffService(sql, threads, providers, "virtual-subhead-results");
    const settleCaptured = (run: AutomationRun) =>
      Effect.gen(function* () {
        const execution = run.steps[0]?.threadId;
        if (!execution) return false;
        const initial = yield* threads.getThreadShell(execution);
        if (!initial || initial.settledOverride === "settled") return false;
        const records = yield* threads.getThreadRecords(execution, ["messages", "runs"]);
        const message = records.messages.find((item) => item.id === run.steps[0]?.messageId);
        const root = message ? inputRootRun(records.runs, message) : undefined;
        const emptyFailedClaim =
          run.status === "failed" && records.messages.length === 0 && records.runs.length === 0;
        if (!root && !emptyFailedClaim) return true;
        const captured = yield* withOwnershipLock(
          sql,
          sql.withTransaction(
            Effect.gen(function* () {
              const metadata = yield* readMetadata(sql, execution);
              if (metadata?.virtualRunId !== run.id) return false;
              if (
                metadata.virtualResultCapturedAt !== undefined &&
                metadata.virtualResultCapturedRunId === root?.id
              )
                return true;
              yield* writeMetadata(sql, {
                ...metadata,
                virtualResultCapturedAt: run.finishedAt ?? run.createdAt,
                ...(root ? { virtualResultCapturedRunId: root.id } : {}),
              });
              return true;
            }),
          ),
        );
        if (!captured) return false;
        const shell = yield* threads.getThreadShell(execution);
        if (
          !shell ||
          shell.latestRunId !== (root?.id ?? null) ||
          hasActiveWork(shell) ||
          (yield* hasLiveChildren(sql, execution, threads.getThreadShell))
        )
          return true;
        yield* threads
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make(
              `subhead:settle:${run.id}:${DateTime.toEpochMillis(shell.updatedAt)}`,
            ),
            threadId: execution,
            ...(root ? { completionRunId: root.id } : {}),
            snapshotAt: shell.updatedAt,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logDebug("Subhead settlement deferred", { runId: run.id, cause }),
            ),
          );
        return (yield* threads.getThreadShell(execution))?.settledOverride !== "settled";
      });
    const deliver = (runId: string) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const found = yield* store.getRun(runId);
            if (Option.isNone(found) || found.value.virtualSubhead === undefined)
              return yield* new NamedAgentError({ message: "Subhead result not found." });
            let run = found.value;
            if (run.status === "queued" || run.status === "running") return run;
            const settlementPending = yield* settleCaptured(run);
            run = { ...run, virtualSubhead: { ...run.virtualSubhead!, settlementPending } };
            yield* store.saveRun(run);
            const virtual = run.virtualSubhead!;
            if (["delivered", "pull-only", "undelivered"].includes(virtual.delivery.status))
              return run;
            const now = DateTime.formatIso(yield* DateTime.now);
            if (
              virtual.delivery.nextAttemptAt &&
              Date.parse(virtual.delivery.nextAttemptAt) > Date.parse(now)
            )
              return run;
            const save = (delivery: typeof virtual.delivery) => {
              const next: AutomationRun = { ...run, virtualSubhead: { ...virtual, delivery } };
              return store.saveRun(next).pipe(Effect.as(next));
            };
            if (virtual.senderThreadId === null)
              return yield* save({ ...virtual.delivery, status: "pull-only" });
            if (virtual.delivery.status === "held") {
              const recipient = yield* threads.getThreadShell(virtual.senderThreadId);
              if (recipient?.settledOverride === "settled") return run;
            }
            const envelope = {
              type: "subhead_result",
              runId: run.id,
              subhead: virtual.template.name,
              templateVersion: virtual.template.version,
              requestId: virtual.requestId,
              executionThreadId: run.steps[0]?.threadId ?? null,
              status: run.status,
              result: run.result,
              finishedAt: run.finishedAt,
            };
            const attempts = virtual.delivery.attempts + 1;
            const retry = (error: string, held = false) =>
              save({
                ...virtual.delivery,
                status:
                  !held &&
                  Date.parse(now) - Date.parse(virtual.delivery.firstAttemptAt ?? now) >=
                    24 * 60 * 60_000
                    ? "undelivered"
                    : held
                      ? "held"
                      : "pending",
                attempts,
                firstAttemptAt: virtual.delivery.firstAttemptAt ?? now,
                nextAttemptAt: new Date(
                  Date.parse(now) + Math.min(5 * 60_000, 15_000 * 2 ** Math.min(attempts - 1, 5)),
                ).toISOString(),
                error,
              });
            return yield* handoffs
              .accept({
                sendId: virtual.delivery.id,
                recipientThreadId: virtual.senderThreadId,
                ...(run.steps[0] ? { senderThreadId: run.steps[0].threadId } : {}),
                text: yield* encodeEnvelope(envelope),
                coalesceKey: null,
                intent: "auto",
                allowQueueFallback: true,
              })
              .pipe(
                Effect.flatMap((receipt) => {
                  if (receipt.cause === "QUOTA_EXHAUSTED" || receipt.cause === "BUSY")
                    return retry(receipt.cause, true);
                  const status =
                    receipt.status === "held"
                      ? "held"
                      : ["accepted", "queued", "started", "steered"].includes(receipt.status)
                        ? "delivered"
                        : "undelivered";
                  return save({
                    ...virtual.delivery,
                    status,
                    attempts,
                    messageId:
                      status === "delivered" ? `handoff:${virtual.delivery.id}:message` : null,
                    error: receipt.cause,
                  });
                }),
                Effect.catch((cause) => retry(String(cause))),
              );
          }),
        )
        .pipe(Effect.mapError(failure));
    const sweep = Effect.gen(function* () {
      const rows = yield* sql<{
        run_id: string;
      }>`SELECT a.run_id FROM automation_runs a LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=json_extract(a.run_json,'$.virtualSubhead.senderThreadId') WHERE a.status NOT IN ('queued','running') AND json_type(a.run_json,'$.virtualSubhead')='object' AND (COALESCE(json_extract(a.run_json,'$.virtualSubhead.settlementPending'),1)=1 OR json_extract(a.run_json,'$.virtualSubhead.delivery.status')='pending' OR (json_extract(a.run_json,'$.virtualSubhead.delivery.status')='held' AND COALESCE(json_extract(t.payload_json,'$.settledOverride'),'')<>'settled')) ORDER BY a.created_at,a.rowid LIMIT 100`;
      for (const row of rows) yield* deliver(row.run_id);
      const pending =
        yield* sql`SELECT run_id FROM automation_runs WHERE status NOT IN ('queued','running') AND json_type(run_json,'$.virtualSubhead')='object' AND json_extract(run_json,'$.virtualSubhead.delivery.status')='pending' LIMIT 1`;
      const held = yield* sql<{
        thread_id: string;
      }>`SELECT DISTINCT json_extract(run_json,'$.virtualSubhead.senderThreadId') AS thread_id FROM automation_runs WHERE json_type(run_json,'$.virtualSubhead')='object' AND json_extract(run_json,'$.virtualSubhead.delivery.status')='held' AND json_extract(run_json,'$.virtualSubhead.senderThreadId') IS NOT NULL`;
      const settlement = yield* sql<{
        thread_id: string;
      }>`SELECT json_extract(run_json,'$.steps[0].threadId') AS thread_id FROM automation_runs WHERE status NOT IN ('queued','running') AND json_extract(run_json,'$.virtualSubhead.settlementPending')=1`;
      return {
        pending: pending.length > 0 || rows.length === 100,
        watched: [...held, ...settlement].map((row) => ThreadId.make(row.thread_id)),
      };
    }).pipe(Effect.mapError(failure));
    return { deliver, sweep };
  });
