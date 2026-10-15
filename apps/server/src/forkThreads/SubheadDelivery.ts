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
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { makeHandoffService } from "./HandoffService.ts";
import { readMetadata, writeMetadata } from "./MetadataStore.ts";
import { withOwnershipLock } from "./NamedAgentPolicy.ts";
import { hasActiveWork } from "./ArchiveDeadlines.ts";
import { hasLiveChildren } from "./WorkerLifecycleMetadata.ts";

const locks = new WeakMap<SqlClient.SqlClient, Semaphore.Semaphore>();
const failure = (cause: unknown) =>
  Schema.is(NamedAgentError)(cause) ? cause : new NamedAgentError({ message: String(cause) });

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
        if (!execution) return;
        yield* withOwnershipLock(
          sql,
          sql.withTransaction(
            Effect.gen(function* () {
              const metadata = yield* readMetadata(sql, execution);
              if (
                metadata?.virtualRunId !== run.id ||
                metadata.virtualResultCapturedAt !== undefined
              )
                return;
              yield* writeMetadata(sql, {
                ...metadata,
                virtualResultCapturedAt: run.finishedAt ?? run.createdAt,
              });
            }),
          ),
        );
        const shell = yield* threads.getThreadShell(execution);
        if (
          !shell ||
          !shell.latestRunId ||
          hasActiveWork(shell) ||
          (yield* hasLiveChildren(sql, execution, threads.getThreadShell))
        )
          return;
        yield* threads
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make(
              `subhead:settle:${run.id}:${DateTime.toEpochMillis(shell.updatedAt)}`,
            ),
            threadId: execution,
            completionRunId: shell.latestRunId,
            snapshotAt: shell.updatedAt,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logDebug("Subhead settlement deferred", { runId: run.id, cause }),
            ),
          );
      });
    const deliver = (runId: string) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const found = yield* store.getRun(runId);
            if (Option.isNone(found) || found.value.virtualSubhead === undefined)
              return yield* new NamedAgentError({ message: "Subhead result not found." });
            const run = found.value;
            const virtual = run.virtualSubhead!;
            if (run.status === "queued" || run.status === "running") return run;
            yield* settleCaptured(run);
            if (["delivered", "pull-only", "undelivered"].includes(virtual.delivery.status))
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
            return yield* handoffs
              .accept({
                sendId: virtual.delivery.id,
                recipientThreadId: virtual.senderThreadId,
                ...(run.steps[0] ? { senderThreadId: run.steps[0].threadId } : {}),
                text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(envelope),
                coalesceKey: null,
                intent: "auto",
                allowQueueFallback: true,
              })
              .pipe(
                Effect.flatMap((receipt) => {
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
                Effect.catch((cause) =>
                  save({
                    ...virtual.delivery,
                    status: attempts >= 6 ? "undelivered" : "pending",
                    attempts,
                    error: String(cause),
                  }),
                ),
              );
          }),
        )
        .pipe(Effect.mapError(failure));
    const sweep = Effect.gen(function* () {
      const rows = yield* sql<{
        run_id: string;
      }>`SELECT a.run_id FROM automation_runs a LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=json_extract(a.run_json,'$.virtualSubhead.senderThreadId') WHERE a.status NOT IN ('queued','running') AND json_type(a.run_json,'$.virtualSubhead')='object' AND (json_extract(a.run_json,'$.virtualSubhead.delivery.status')='pending' OR (json_extract(a.run_json,'$.virtualSubhead.delivery.status')='held' AND COALESCE(json_extract(t.payload_json,'$.settledOverride'),'')<>'settled')) ORDER BY a.created_at,a.rowid LIMIT 100`;
      for (const row of rows) yield* deliver(row.run_id);
      const pending =
        yield* sql`SELECT run_id FROM automation_runs WHERE status NOT IN ('queued','running') AND json_type(run_json,'$.virtualSubhead')='object' AND json_extract(run_json,'$.virtualSubhead.delivery.status')='pending' LIMIT 1`;
      const held = yield* sql<{
        thread_id: string;
      }>`SELECT DISTINCT json_extract(run_json,'$.virtualSubhead.senderThreadId') AS thread_id FROM automation_runs WHERE json_type(run_json,'$.virtualSubhead')='object' AND json_extract(run_json,'$.virtualSubhead.delivery.status')='held' AND json_extract(run_json,'$.virtualSubhead.senderThreadId') IS NOT NULL`;
      return {
        pending: pending.length > 0 || rows.length === 100,
        watched: held.map((row) => ThreadId.make(row.thread_id)),
      };
    }).pipe(Effect.mapError(failure));
    return { deliver, sweep };
  });
