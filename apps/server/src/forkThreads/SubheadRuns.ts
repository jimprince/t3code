import {
  NamedAgentError,
  SubheadSendInput,
  SubheadTemplate,
  ThreadId,
  MessageId,
  AutomationRun,
  type RuntimeMode,
  type SubheadRunRow,
  type Subhead,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AutomationStore } from "../automations/AutomationStore.ts";
import { makeSubheadRegistry } from "./SubheadRegistry.ts";
import { withOwnershipLock } from "./NamedAgentPolicy.ts";
import { runtimeModeRank } from "@t3tools/shared/providerRuntimeMode";

/** Supplied by authentication, never by request headers or shell thread IDs. */
export interface SubheadCaller {
  readonly environmentId: string;
  readonly principal: string;
  readonly threadId: ThreadId | null;
  readonly runtimeMode: RuntimeMode;
  /** Holds the administrative scope: may change subheads other principals created. */
  readonly administrator?: boolean;
}
const isNamedAgentError = Schema.is(NamedAgentError);
const decodeSend = Schema.decodeUnknownEffect(SubheadSendInput);

const fail = (message: string) => new NamedAgentError({ message });
const error = (cause: unknown) => (isNamedAgentError(cause) ? cause : fail(String(cause)));
const encodeTemplate = Schema.encodeSync(Schema.fromJsonString(SubheadTemplate));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(AutomationRun));
const OPEN = ["queued", "running"];
/** Finished runs with an unresolved delivery that `list` keeps visible per subhead. */
const ATTENTION_PER_SUBHEAD = 20;
/** Request text in lists is a summary; the full text belongs to the run's sender. */
const summarize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

/** Admission owns only the existing run store. Native execution belongs to AutomationEngine. */
export const makeSubheadRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* AutomationStore;
  const registry = yield* makeSubheadRegistry;
  const crypto = yield* Crypto.Crypto;
  const digest = (value: unknown) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))
      .pipe(
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );
  const send = (
    caller: SubheadCaller,
    raw: unknown,
    validate?: (entry: Subhead) => Effect.Effect<void, NamedAgentError>,
  ) =>
    withOwnershipLock(
      sql,
      store.transaction(
        Effect.gen(function* () {
          const input = yield* decodeSend(raw, {
            onExcessProperty: "error",
          });
          if (caller.threadId !== null) {
            const recursive = yield* sql`WITH RECURSIVE lineage(thread_id) AS (
                SELECT ${caller.threadId} UNION SELECT json_extract(m.payload,'$.parentThreadId') FROM fork_thread_metadata m JOIN lineage l ON m.thread_id=l.thread_id
              ) SELECT thread_id FROM lineage WHERE thread_id IN (SELECT thread_id FROM fork_thread_metadata WHERE json_extract(payload,'$.virtualRunId') IS NOT NULL)
              OR thread_id IN (SELECT json_extract(run_json,'$.steps[0].threadId') FROM automation_runs WHERE json_type(run_json,'$.virtualSubhead')='object') LIMIT 1`;
            if (recursive.length)
              return yield* fail("Subhead recursion is disabled for authenticated run callers.");
          }
          const entry = yield* registry.get(input.name);
          const id = `subhead:${yield* digest([caller.environmentId, caller.principal, entry.id, input.requestId])}`;
          const requestHash = yield* digest([input.request, caller.threadId]);
          const existing = yield* store.getRun(id);
          if (Option.isSome(existing)) {
            if (existing.value.virtualSubhead?.requestHash !== requestHash)
              return yield* fail(
                "Request id conflict: this key already has different content or a different return destination.",
              );
            return existing.value;
          }
          if (!entry.enabled || entry.retiredAt !== null)
            return yield* fail("Subhead is disabled or retired.");
          if (runtimeModeRank(entry.runtimeMode) > runtimeModeRank(caller.runtimeMode))
            return yield* fail(
              "Subhead permissions exceed the authenticated caller's permission ceiling.",
            );
          if (validate) yield* validate(entry);
          const time = yield* DateTime.now;
          const at = DateTime.formatIso(time);
          const since = DateTime.formatIso(DateTime.subtract(time, { minutes: 10 }));
          const day = `${at.slice(0, 10)}T00:00:00.000Z`;
          const automationId = `subhead:${entry.id}`;
          const [rate] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM automation_runs WHERE json_type(run_json,'$.virtualSubhead')='object' AND json_extract(run_json,'$.virtualSubhead.senderPrincipal')=${caller.principal} AND created_at>=${since}`;
          if ((rate?.count ?? 0) >= 3)
            return yield* fail("Sender admission rate limit reached (3 requests per 10 minutes).");
          const [daily] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id=${automationId} AND created_at>=${day}`;
          if ((daily?.count ?? 0) >= 20)
            return yield* fail("Subhead daily admission limit reached (20 requests).");
          const [queued] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id=${automationId} AND status='queued'`;
          if ((queued?.count ?? 0) >= 10)
            return yield* fail("Subhead queue is full (10 requests).");
          const templateHash = yield* digest([entry.id, entry.version, encodeTemplate(entry)]);
          const threadId = ThreadId.make(`${id}:thread`);
          const messageId = MessageId.make(`${id}:request`);
          const prompt = `${entry.prompt}\n\nRequest (${input.requestId}):\n${input.request}\n\nReturn your result in this thread. The application delivers it once to the sender; do not send a separate completion. Subhead recursion is disabled.`;
          const run: AutomationRun = {
            id,
            automationId,
            projectId: entry.projectId,
            name: entry.name,
            dedupeKey: id,
            trigger: { kind: "manual" },
            ownerThreadId: entry.ownerThreadId,
            dryRun: false,
            status: "queued",
            result: null,
            createdAt: at,
            finishedAt: null,
            steps: [
              {
                kind: "agent",
                status: "queued",
                target: { kind: "new-thread" },
                threadId,
                messageId,
                title: entry.name,
                prompt,
                result: null,
                startedAt: null,
                finishedAt: null,
              },
            ],
            virtualSubhead: {
              agentId: entry.id,
              environmentId: caller.environmentId,
              template: entry,
              templateHash,
              senderPrincipal: caller.principal,
              senderThreadId: caller.threadId,
              requestId: input.requestId,
              request: input.request,
              requestHash,
              blockedReason: null,
              leaseStartedAt: null,
              terminationReason: null,
              delivery: {
                id: `subhead-result:${id}`,
                status: "pending",
                messageId: null,
                attempts: 0,
                error: null,
              },
            },
          };
          if (!(yield* store.insertRun(run)))
            return yield* fail("Concurrent run admission conflict; retry the same request id.");
          return run;
        }),
      ),
    ).pipe(Effect.mapError(error));
  const read = (caller: SubheadCaller, runId: string) =>
    Effect.gen(function* () {
      const found = yield* store.getRun(runId);
      if (Option.isNone(found) || found.value.virtualSubhead === undefined)
        return yield* fail("Subhead run not found.");
      const run = found.value;
      if (
        run.virtualSubhead!.environmentId !== caller.environmentId ||
        run.virtualSubhead!.senderPrincipal !== caller.principal
      )
        return yield* fail("This authenticated sender cannot read that subhead result.");
      return run;
    }).pipe(Effect.mapError(error));
  /**
   * Operator view of runs: every open run plus the newest `perSubhead` finished runs of each
   * subhead (or of the one named), plus the newest `attentionPerSubhead` finished runs whose
   * delivery needs a look (undelivered, held, or still retrying), however old, so a lost result
   * does not fall out of the window. Rows carry no result text; reading that still needs the
   * authenticated sender. Newest first.
   */
  const list = (input: {
    readonly name?: string | undefined;
    readonly perSubhead: number;
    readonly attentionPerSubhead?: number | undefined;
  }) =>
    Effect.gen(function* () {
      const attentionCap = input.attentionPerSubhead ?? ATTENTION_PER_SUBHEAD;
      const only = input.name === undefined ? null : (yield* registry.get(input.name)).id;
      const automationId = only === null ? null : `subhead:${only}`;
      const rows = yield* sql<{ json: string }>`
        SELECT run_json AS json FROM automation_runs
        WHERE json_type(run_json,'$.virtualSubhead')='object'
          AND (${automationId} IS NULL OR automation_id=${automationId})
          AND (status IN (${OPEN[0]!},${OPEN[1]!}) OR run_id IN (
            SELECT run_id FROM (
              SELECT run_id, ROW_NUMBER() OVER (
                PARTITION BY automation_id ORDER BY created_at DESC, run_id DESC) AS rn
              FROM automation_runs
              WHERE json_type(run_json,'$.virtualSubhead')='object' AND status NOT IN (${OPEN[0]!},${OPEN[1]!})
            ) WHERE rn<=${input.perSubhead})
          OR run_id IN (
            SELECT run_id FROM (
              SELECT run_id, ROW_NUMBER() OVER (
                PARTITION BY automation_id ORDER BY created_at DESC, run_id DESC) AS rn
              FROM automation_runs
              WHERE json_type(run_json,'$.virtualSubhead')='object' AND status NOT IN (${OPEN[0]!},${OPEN[1]!})
                AND json_extract(run_json,'$.virtualSubhead.delivery.status') IN ('undelivered','held','pending')
            ) WHERE rn<=${attentionCap}))
        ORDER BY created_at DESC, run_id DESC`;
      const runs = yield* Effect.forEach(rows, (row) => decodeRun(row.json));
      return runs.flatMap((run): SubheadRunRow[] => {
        const virtual = run.virtualSubhead;
        if (virtual === undefined) return [];
        return [
          {
            runId: run.id,
            agentId: virtual.agentId,
            subheadName: virtual.template.name,
            requestId: virtual.requestId,
            requestSummary: summarize(virtual.request),
            senderPrincipal: virtual.senderPrincipal,
            senderThreadId: virtual.senderThreadId,
            templateVersion: virtual.template.version,
            status: run.status,
            threadId: run.steps[0]?.threadId ?? null,
            delivery: virtual.delivery,
            blockedReason: virtual.blockedReason,
            terminationReason: virtual.terminationReason,
            createdAt: run.createdAt,
            finishedAt: run.finishedAt,
          },
        ];
      });
    }).pipe(Effect.mapError(error));
  return { send, read, list };
});
