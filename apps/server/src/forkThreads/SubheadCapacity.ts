import { NamedAgentError, ThreadId, type AutomationRun } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { AutomationStore } from "../automations/AutomationStore.ts";
import { makeSubheadRegistry } from "./SubheadRegistry.ts";
import { withOwnershipLock } from "./NamedAgentPolicy.ts";

const registrySchemas = new WeakMap<SqlClient.SqlClient, boolean>();
/** Only the app-owned handoff transport can supply this, never an RPC parameter. */
export const SubheadResultAdmission = Context.Reference<ThreadId | null>(
  "t3/SubheadResultAdmission",
  {
    defaultValue: () => null,
  },
);
const hasRegistry = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    let ready = registrySchemas.get(sql);
    if (ready === undefined) {
      const rows =
        yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('named_virtual_agents','fork_thread_metadata')`;
      ready = rows.length === 2;
      registrySchemas.set(sql, ready);
    }
    if (!ready) return false;
    return (
      (yield* sql`SELECT id FROM named_virtual_agents WHERE json_extract(payload,'$.enabled')=1 AND json_extract(payload,'$.retiredAt') IS NULL UNION ALL SELECT run_id AS id FROM automation_runs WHERE status IN ('queued','running') AND json_type(run_json,'$.virtualSubhead')='object' LIMIT 1`)
        .length > 0
    );
  });

/** Only heads that opted into virtual helpers acquire this shared worker ceiling. */
const ancestorHeads = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  includeInactive = false,
) => sql<{ thread_id: string }>`
  WITH RECURSIVE ancestors(thread_id) AS (
    SELECT json_extract(payload,'$.parentThreadId') FROM fork_thread_metadata WHERE thread_id=${threadId}
    UNION SELECT json_extract(m.payload,'$.parentThreadId') FROM fork_thread_metadata m JOIN ancestors a ON m.thread_id=a.thread_id
  ) SELECT DISTINCT a.thread_id FROM ancestors a WHERE a.thread_id IS NOT NULL AND (
    EXISTS(SELECT 1 FROM named_virtual_agents n WHERE json_extract(n.payload,'$.ownerThreadId')=a.thread_id AND (${includeInactive ? 1 : 0}=1 OR (json_extract(n.payload,'$.enabled')=1 AND json_extract(n.payload,'$.retiredAt') IS NULL)))
    OR EXISTS(SELECT 1 FROM automation_runs r WHERE r.status IN ('queued','running') AND json_type(r.run_json,'$.virtualSubhead')='object' AND json_extract(r.run_json,'$.ownerThreadId')=a.thread_id))
`;

/** Native work and pre-launch virtual leases are one set of execution threads, not two caps. */
const headHasRoom = (sql: SqlClient.SqlClient, head: ThreadId, except: ThreadId) =>
  sql<{ thread_id: string }>`
  WITH RECURSIVE children(thread_id) AS (
    SELECT thread_id FROM fork_thread_metadata WHERE json_extract(payload,'$.parentThreadId')=${head}
    UNION SELECT m.thread_id FROM fork_thread_metadata m JOIN children c ON json_extract(m.payload,'$.parentThreadId')=c.thread_id
  ), released(thread_id,message_id) AS (
    SELECT json_extract(run_json,'$.steps[0].threadId'),json_extract(run_json,'$.steps[0].messageId') FROM automation_runs WHERE status NOT IN ('queued','running') AND json_type(run_json,'$.virtualSubhead')='object'
  ), occupied(thread_id) AS (
    SELECT r.thread_id FROM orchestration_v2_projection_runs r JOIN children c ON r.thread_id=c.thread_id WHERE r.status IN ('preparing','starting','running','waiting') AND NOT EXISTS(SELECT 1 FROM released v WHERE v.thread_id=r.thread_id AND v.message_id=json_extract(r.payload_json,'$.userMessageId'))
    UNION SELECT p.thread_id FROM orchestration_v2_projection_provider_threads p JOIN children c ON p.thread_id=c.thread_id WHERE (json_array_length(json_extract(p.payload_json,'$.pendingBackgroundTasks'))>0 OR json_extract(p.payload_json,'$.goal.status')='active') AND NOT EXISTS(SELECT 1 FROM released v JOIN orchestration_v2_projection_runs r ON r.thread_id=v.thread_id AND json_extract(r.payload_json,'$.userMessageId')=v.message_id WHERE v.thread_id=p.thread_id AND r.ordinal=(SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest WHERE latest.thread_id=p.thread_id))
    UNION SELECT json_extract(a.run_json,'$.steps[0].threadId') FROM automation_runs a WHERE a.status='running' AND json_type(a.run_json,'$.virtualSubhead')='object'
      AND (json_extract(a.run_json,'$.ownerThreadId')=${head} OR json_extract(a.run_json,'$.ownerThreadId') IN (SELECT thread_id FROM children))
  ) SELECT thread_id FROM occupied WHERE thread_id<>${except} LIMIT 2
`.pipe(Effect.map((rows) => rows.length < 2));

/** Called under native ownership serialization at initial input and every queue promotion. */
export const canStartSubheadWorker = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    if ((yield* SubheadResultAdmission) === threadId) return true;
    if (!(yield* hasRegistry(sql))) return true;
    for (const head of yield* ancestorHeads(sql, threadId)) {
      if (!(yield* headHasRoom(sql, ThreadId.make(head.thread_id), threadId))) return false;
    }
    return true;
  });

/** Held queues remain a user decision. Only unheld queues of opted-in heads are candidates. */
export const subheadCapacityQueueCandidates = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* hasRegistry(sql);
    if (registrySchemas.get(sql) !== true) return [] as ThreadId[];
    if ((yield* sql`SELECT id FROM named_virtual_agents LIMIT 1`).length === 0)
      return [] as ThreadId[];
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT DISTINCT r.thread_id FROM orchestration_v2_projection_runs r WHERE r.status='queued' AND COALESCE(json_extract(r.payload_json,'$.queueHeld'),0)=0 ORDER BY r.requested_at LIMIT 100`;
    const candidates: ThreadId[] = [];
    for (const row of rows) {
      const id = ThreadId.make(row.thread_id);
      if ((yield* ancestorHeads(sql, id, true)).length > 0) candidates.push(id);
    }
    return candidates;
  });

export const makeSubheadCapacity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* AutomationStore;
  const registry = yield* makeSubheadRegistry;
  const reserve = (runId: string) =>
    withOwnershipLock(
      sql,
      store.transaction(
        Effect.gen(function* () {
          const found = yield* store.getRun(runId);
          if (Option.isNone(found) || found.value.virtualSubhead === undefined) return false;
          const run = found.value;
          if (run.status === "running") return true;
          if (run.status !== "queued") return false;
          const virtual = run.virtualSubhead!;
          const current = yield* registry.get(virtual.template.name);
          const blocked = (reason: string) =>
            store
              .saveRun({ ...run, virtualSubhead: { ...virtual, blockedReason: reason } })
              .pipe(Effect.as(false));
          if (!current.enabled || current.retiredAt !== null)
            return yield* blocked("Helper disabled or retired.");
          const first = yield* sql<{
            run_id: string;
          }>`SELECT run_id FROM automation_runs WHERE automation_id=${run.automationId} AND status='queued' ORDER BY created_at,rowid LIMIT 1`;
          if (first[0]?.run_id !== run.id) return yield* blocked("Waiting for an earlier request.");
          const [active] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id=${run.automationId} AND status='running'`;
          if ((active?.count ?? 0) >= Math.min(current.concurrency, virtual.template.concurrency))
            return yield* blocked("Helper concurrency capacity is full.");
          const execution = run.steps[0]?.threadId;
          if (!execution)
            return yield* new NamedAgentError({
              message: "Virtual run has no persisted execution identity.",
            });
          const heads = [
            virtual.template.ownerThreadId,
            ...(yield* ancestorHeads(sql, virtual.template.ownerThreadId)).map((row) =>
              ThreadId.make(row.thread_id),
            ),
          ];
          for (const head of heads)
            if (!(yield* headHasRoom(sql, head, execution)))
              return yield* blocked("Owning head capacity is full (2 worker turns).");
          const reserved: AutomationRun = {
            ...run,
            status: "running",
            virtualSubhead: {
              ...virtual,
              blockedReason: null,
              leaseStartedAt: DateTime.formatIso(yield* DateTime.now),
            },
          };
          yield* store.saveRun(reserved);
          return true;
        }),
      ),
    );
  return {
    reserve,
    canStart: (id: ThreadId) => canStartSubheadWorker(sql, id),
    queuedPeers: subheadCapacityQueueCandidates(sql),
  };
});
