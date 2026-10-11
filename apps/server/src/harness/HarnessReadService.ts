import { effectivePurpose } from "@t3tools/client-runtime/state/thread-purpose";
import {
  EnvironmentId,
  HarnessReadError,
  HarnessSnapshotInput,
  ProjectAutomation,
  ProjectId,
  ScheduledTaskSchedule,
  type Automation,
  type AutomationRun,
  type HarnessAgent,
  type HarnessRoutine,
  type HarnessRun,
  type HarnessSnapshot,
  type HarnessSnapshotInput as SnapshotInput,
  type HarnessSource,
  type HarnessThreadLink,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AutomationStore from "../automations/AutomationStore.ts";
import { nextScheduledRun } from "../automations/schedule.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { listMetadata } from "../forkThreads/MetadataStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import {
  FEED_FILES,
  feedRoutines,
  findingsReceipts,
  readFeed,
  type FeedFile,
  type FeedRead,
} from "./feeds.ts";
import { groupAgents, lateness, routine, threadLink } from "./model.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ACTIVE = ["preparing", "queued", "starting", "running", "waiting"];
const iso = () => Effect.map(DateTime.now, DateTime.formatIso);
interface MessageRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly created_at: string;
}
interface ExecutionRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly status: string;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly started_at: string | null;
  readonly user_message_id: string | null;
}
interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly parent: string | null;
  readonly relationship: string | null;
  readonly bounded: number;
}
interface TaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly run_count: number;
}
export class HarnessReadService extends Context.Service<
  HarnessReadService,
  {
    readonly snapshot: (input: SnapshotInput) => Effect.Effect<HarnessSnapshot, HarnessReadError>;
  }
>()("t3/harness/HarnessReadService") {}

/** No global newest-N window: the task tag index retrieves history independently per ID. */
export function taskMessages(
  sql: SqlClient.SqlClient,
  task: Pick<TaskRow, "task_id" | "project_id" | "thread_id">,
  limit: number,
  active = false,
) {
  return sql<MessageRow>`
    SELECT m.message_id, m.thread_id, m.run_id, m.created_at
    FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
    LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id AND r.thread_id = m.thread_id
    WHERE m.role = 'user'
      AND CASE WHEN json_valid(m.payload_json) THEN json_extract(m.payload_json, '$.scheduledTaskId') END = ${task.task_id}
      AND t.project_id = ${task.project_id}
      AND (${task.thread_id} IS NULL OR m.thread_id = ${task.thread_id})
      AND (${active ? 1 : 0} = 0 OR r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting'))
    ORDER BY m.created_at DESC, m.message_id DESC ${active ? sql`` : sql`LIMIT ${limit}`}
  `;
}

/** Exact user message -> root run, then distinct items in that same thread/run only. */
export function executionEvidence(sql: SqlClient.SqlClient, links: readonly HarnessThreadLink[]) {
  return Effect.gen(function* () {
    const ids = [
      ...new Set(links.map((link) => link.messageId).filter((id): id is string => id !== null)),
    ];
    const evidence = new Map<
      string,
      { link: HarnessThreadLink; execution: ExecutionRow | null; errors: number | null }
    >();
    if (!ids.length) return evidence;
    const messages =
      yield* sql<MessageRow>`SELECT message_id, thread_id, run_id, created_at FROM orchestration_v2_projection_messages WHERE role = 'user' AND message_id IN ${sql.in(ids)}`;
    const runIds = [
      ...new Set(
        messages.map((message) => message.run_id).filter((id): id is string => id !== null),
      ),
    ];
    const runs = runIds.length
      ? yield* sql<ExecutionRow>`SELECT run_id, thread_id, status, requested_at, completed_at, json_extract(payload_json, '$.startedAt') AS started_at, json_extract(payload_json, '$.userMessageId') AS user_message_id FROM orchestration_v2_projection_runs WHERE run_id IN ${sql.in(runIds)}`
      : [];
    const counts = runIds.length
      ? yield* sql<{
          run_id: string;
          thread_id: string;
          items: number;
          errors: number;
        }>`SELECT run_id, thread_id, COUNT(*) AS items, COUNT(DISTINCT CASE WHEN type = 'error' THEN turn_item_id END) AS errors FROM orchestration_v2_projection_turn_items WHERE run_id IN ${sql.in(runIds)} GROUP BY run_id, thread_id`
      : [];
    for (const link of links) {
      const message = messages.find(
        (message) => message.message_id === link.messageId && message.thread_id === link.threadId,
      );
      const execution =
        runs.find(
          (run) =>
            run.run_id === message?.run_id &&
            run.thread_id === link.threadId &&
            run.user_message_id === link.messageId,
        ) ?? null;
      const count = counts.find(
        (count) => count.run_id === execution?.run_id && count.thread_id === link.threadId,
      );
      evidence.set(`${link.threadId}\0${link.messageId}`, {
        link: { ...link, runId: execution?.run_id ?? null },
        execution,
        errors: count && count.items > 0 ? count.errors : null,
      });
    }
    return evidence;
  });
}

function outcome(status: string): HarnessRun["outcome"] {
  if (ACTIVE.includes(status))
    return status === "queued" || status === "preparing" ? "queued" : "running";
  return ["completed", "failed", "interrupted", "cancelled", "skipped"].includes(status)
    ? (status as HarnessRun["outcome"])
    : "unknown";
}
function automationLinks(environmentId: EnvironmentId, run: AutomationRun) {
  return run.steps.map((step) => threadLink(environmentId, step.threadId, null, step.messageId));
}
function executionRun(
  environmentId: EnvironmentId,
  message: MessageRow,
  evidence:
    | { execution: ExecutionRow | null; errors: number | null; link: HarnessThreadLink }
    | undefined,
): HarnessRun {
  const execution = evidence?.execution;
  return {
    key: execution?.run_id ?? message.message_id,
    expectedAt: null,
    requestedAt: execution?.requested_at ?? message.created_at,
    startedAt: execution?.started_at ?? null,
    finishedAt: execution?.completed_at ?? null,
    outcome: execution ? outcome(execution.status) : "unknown",
    outcomeKind: execution ? "execution" : "dispatch",
    dryRun: false,
    errorCount: null,
    runtimeErrorCount: evidence?.errors ?? null,
    evidence: execution
      ? "Exact tagged user message and root run. No findings receipt."
      : "Dispatch only; exact root execution unavailable.",
    threads: [
      evidence?.link ?? threadLink(environmentId, message.thread_id, null, message.message_id),
    ],
  };
}

/** Sources are stamped separately: this is deliberately an honest non-atomic read model. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const automations = yield* AutomationStore.AutomationStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const directory = yield* Config.String("T3CODE_HARNESS_FEED_DIR").pipe(Config.withDefault(""));
  const graceMs = yield* Config.Int("T3CODE_HARNESS_LATE_GRACE_MS").pipe(Config.withDefault(0));
  const staleMs = yield* Config.Int("T3CODE_HARNESS_FEED_STALE_MS").pipe(
    Config.withDefault(300_000),
  );
  const hostJson = yield* Config.String("T3CODE_HARNESS_FEED_ENVIRONMENTS").pipe(
    Config.withDefault("{}"),
  );
  const hosts = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, EnvironmentId)),
  )(hostJson);
  if (graceMs < 0 || staleMs < 0)
    return yield* new HarnessReadError({
      message: "Harness grace/freshness allowances must be nonnegative.",
    });

  const readSnapshot = Effect.fn("HarnessReadService.snapshot")(
    function* (input: SnapshotInput) {
      const generatedAt = yield* iso();
      const limit = input.historyLimit ?? 10;
      const sources: HarnessSource[] = [];
      const source = <A, E>(key: string, effect: Effect.Effect<A, E>, fallback: A) =>
        Effect.gen(function* () {
          const readAt = yield* iso();
          return yield* effect.pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                sources.push({
                  key,
                  readAt,
                  observedAt: readAt,
                  status: "available",
                  evidence: "Environment-local persisted read; snapshot is non-atomic.",
                }),
              ),
            ),
            Effect.catch(() => {
              sources.push({
                key,
                readAt,
                observedAt: null,
                status: "unavailable",
                evidence: "Source read unavailable; no healthy inference.",
              });
              return Effect.succeed(fallback);
            }),
          );
        });
      const threads = yield* source(
        "threads",
        sql<ThreadRow>`SELECT t.thread_id, t.project_id, t.title,
          json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent,
          json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
          CASE WHEN json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
            AND (json_extract(t.payload_json, '$.creationSource') = 'provider' OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_subagents s WHERE s.child_thread_id = t.thread_id
              AND s.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
            )) THEN 1 ELSE 0 END AS bounded
          FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NULL`,
        [],
      );
      const metadata = yield* source("purpose", listMetadata(sql), []);
      const byId = new Map(metadata.map((row) => [String(row.threadId), row]));
      const purposes = effectivePurpose(
        threads.map((thread) => {
          const row = byId.get(thread.thread_id);
          return {
            key: `${environmentId}:${thread.thread_id}`,
            parentKey: row?.remoteParent
              ? `${row.remoteParent.environmentId}:${row.remoteParent.threadId}`
              : row?.parentThreadId
                ? `${environmentId}:${row.parentThreadId}`
                : !row && thread.relationship === "subagent" && thread.parent
                  ? `${environmentId}:${thread.parent}`
                  : null,
            purpose: row?.purpose,
            unavailable: sources.some(
              (source) => source.key === "purpose" && source.status !== "available",
            ),
          };
        }),
      );
      const membership = (id: string | undefined | null) =>
        id ? (purposes.get(`${environmentId}:${id}`) ?? null) : null;
      const include = (projectId: ProjectId) =>
        input.projectIds === undefined || input.projectIds.includes(projectId);
      const rows: HarnessRoutine[] = [];
      const definitions = yield* source("automations", automations.listAutomations(), []);
      const active = yield* source("automation-active-runs", automations.activeRuns, []);
      const modernIds = yield* source(
        "automation-identities",
        sql<{
          automation_id: string;
          project_id: string;
        }>`SELECT automation_id, project_id FROM automations`,
        [],
      );
      const projectRows = yield* source(
        "legacy-automations",
        projects.list(input.projectIds ? { projectIds: input.projectIds } : undefined),
        [],
      );
      const tasks = yield* source(
        "scheduled-tasks",
        sql<TaskRow>`SELECT * FROM scheduled_tasks`,
        [],
      );
      const taskHistories = new Map<string, readonly MessageRow[]>();
      const taskActive = new Map<string, readonly MessageRow[]>();
      const automationHistories = new Map<string, readonly AutomationRun[]>();
      for (const definition of definitions.filter((definition) => include(definition.projectId)))
        automationHistories.set(
          definition.id,
          yield* source(
            `automation-runs:${definition.id}`,
            automations.listRuns({
              automationId: definition.id,
              projectId: definition.projectId,
              limit: limit + 1,
            }),
            [],
          ),
        );
      for (const task of tasks.filter((task) => include(ProjectId.make(task.project_id)))) {
        taskHistories.set(
          task.task_id,
          yield* source(`task-runs:${task.task_id}`, taskMessages(sql, task, limit + 1), []),
        );
        taskActive.set(
          task.task_id,
          yield* source(`task-active:${task.task_id}`, taskMessages(sql, task, limit, true), []),
        );
      }
      const legacy = projectRows.flatMap((project) =>
        (project.automations ?? [])
          .filter(
            (definition) =>
              !modernIds.some(
                (current) =>
                  current.automation_id === definition.id &&
                  current.project_id === project.projectId,
              ),
          )
          .map((definition) => ({
            definition,
            projectId: project.projectId,
            createdAt: project.createdAt,
          })),
      );
      const links = [...active, ...[...automationHistories.values()].flat()].flatMap((run) =>
        automationLinks(environmentId, run),
      );
      for (const { definition } of legacy)
        for (const run of definition.runs)
          if (run.threadId && run.messageId)
            links.push(threadLink(environmentId, run.threadId, null, run.messageId));
      for (const message of [...taskHistories.values(), ...taskActive.values()].flat())
        links.push(
          threadLink(environmentId, message.thread_id, message.run_id, message.message_id),
        );
      const evidence = yield* source(
        "execution-evidence",
        executionEvidence(sql, links),
        new Map(),
      );
      const liveThreads = yield* source(
        "active-executions",
        sql<{
          thread_id: string;
        }>`SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'queued', 'starting', 'running', 'waiting')`,
        [],
      );
      const executionReady =
        sources.find((source) => source.key === "active-executions")?.status === "available";
      const live = (
        target: string | null,
        runs: readonly HarnessRun[],
        ready = true,
      ): HarnessRoutine["liveness"] =>
        runs.some(
          (run) =>
            run.outcomeKind === "execution" &&
            (run.outcome === "running" || run.outcome === "queued"),
        ) ||
        (target !== null && liveThreads.some((thread) => thread.thread_id === target))
          ? "active"
          : !ready ||
              runs.some(
                (run) =>
                  run.outcomeKind === "dispatch" &&
                  (run.outcome === "running" || run.outcome === "queued"),
              ) ||
              !executionReady ||
              (target !== null && !threads.some((thread) => thread.thread_id === target))
            ? "unknown"
            : "not currently live";
      const appRun = (run: AutomationRun): HarnessRun => {
        const matches = [
          ...new Map(
            automationLinks(environmentId, run).map((link) => {
              const match = evidence.get(`${link.threadId}\0${link.messageId}`);
              return [match?.execution?.run_id ?? link.messageId, match] as const;
            }),
          ).values(),
        ];
        const executed =
          !run.dryRun &&
          matches.length > 0 &&
          matches.every((match) => match?.execution !== null && match?.execution !== undefined);
        return {
          key: run.id,
          expectedAt: run.trigger.kind === "schedule" ? run.trigger.scheduledAt : null,
          requestedAt: run.createdAt,
          startedAt: run.steps.find((step) => step.startedAt)?.startedAt ?? null,
          finishedAt: run.finishedAt,
          outcome: executed
            ? ((["failed", "interrupted", "cancelled", "running", "queued"] as const).find(
                (status) =>
                  matches.some((match) => match && outcome(match.execution!.status) === status),
              ) ??
              (matches.every((match) => match && outcome(match.execution!.status) === "completed")
                ? "completed"
                : "unknown"))
            : run.status === "failed" || run.status === "skipped"
              ? run.status
              : run.status === "running" || run.status === "queued"
                ? run.status
                : "unknown",
          outcomeKind: executed ? "execution" : "dispatch",
          dryRun: run.dryRun,
          errorCount: null,
          runtimeErrorCount:
            executed &&
            matches.every((match) => match?.errors !== null && match?.errors !== undefined)
              ? matches.reduce((sum, match) => sum + match!.errors!, 0)
              : null,
          evidence: executed
            ? "Exact step user-message/root-run join; findings unavailable."
            : "Automation receipt only; no complete exact execution evidence.",
          threads: automationLinks(environmentId, run).map(
            (link) => evidence.get(`${link.threadId}\0${link.messageId}`)?.link ?? link,
          ),
        };
      };
      const addAutomation = (
        definition: Automation,
        history: readonly HarnessRun[],
        activeRuns: readonly HarnessRun[],
        sourceKey: string,
      ) => {
        const targets = definition.actions.map((action) =>
          action.target.kind === "existing-thread" ? String(action.target.threadId) : null,
        );
        const target = targets.length === 1 ? (targets[0] ?? null) : null;
        const purpose = membership(target) ?? membership(definition.ownerThreadId);
        if (purpose === "project") return;
        const next = (after: string) => nextScheduledRun(definition.triggers, after);
        const expected = history
          .filter((run) => run.expectedAt !== null)
          .map((run) => run.expectedAt!)
          .sort();
        const start = expected[0] ?? definition.nextRunAt ?? next(definition.createdAt);
        rows.push(
          routine({
            key: `${environmentId}:${sourceKey}:${definition.id}`,
            agentKey: target
              ? `${environmentId}:thread:${target}`
              : `${environmentId}:automation:${definition.id}`,
            name: definition.name,
            whatItChecks: definition.actions
              .map((action) => action.script ?? action.prompt ?? "unknown")
              .join("\n")
              .slice(0, 4000),
            environmentId,
            projectId: definition.projectId,
            owner: definition.ownerThreadId
              ? threadLink(environmentId, definition.ownerThreadId)
              : target
                ? threadLink(environmentId, target)
                : null,
            purpose: purpose === "harness" ? "harness" : "unclassified",
            source: sourceKey,
            sourceStale: sources.some(
              (source) =>
                [
                  sourceKey,
                  "threads",
                  "purpose",
                  "automation-identities",
                  `automation-runs:${definition.id}`,
                  "execution-evidence",
                ].includes(source.key) && source.status !== "available",
            ),
            state: !definition.enabled
              ? "disabled"
              : history[0]?.outcome === "failed"
                ? "failing"
                : "enabled",
            lifecycle: target
              ? threads.some((thread) => thread.thread_id === target)
                ? threads.find((thread) => thread.thread_id === target)?.bounded === 1
                  ? "conditional"
                  : "standing"
                : null
              : "conditional",
            context: target ? "persistent" : "new-instance-per-run",
            scheduleOrTrigger: encodeJson(definition.triggers),
            nextExpectedRun: definition.enabled
              ? (definition.nextRunAt ?? next(generatedAt))
              : null,
            lateness: lateness({
              enabled: definition.enabled,
              now: generatedAt,
              nextRunAt: definition.nextRunAt,
              windowStart: start,
              next,
              runs: [...history, ...activeRuns],
              graceMs,
            }),
            liveness: live(
              target,
              activeRuns,
              sources.find((source) => source.key === "automation-active-runs")?.status ===
                "available",
            ),
            history: history.slice(0, limit),
            activeRuns,
            historyCoverage: {
              retainedFrom: history.at(-1)?.requestedAt ?? null,
              truncated: true,
              evidence: `Newest ${limit} per rule; app retains up to 50 finished runs. Active runs queried independently.`,
            },
          }),
        );
      };
      for (const definition of definitions.filter((definition) => include(definition.projectId)))
        addAutomation(
          definition,
          (automationHistories.get(definition.id) ?? []).map(appRun),
          active
            .filter(
              (run) => run.automationId === definition.id && run.projectId === definition.projectId,
            )
            .map(appRun),
          "automations",
        );
      for (const { definition, projectId, createdAt } of legacy) {
        const normalized = yield* Schema.decodeUnknownEffect(ProjectAutomation)(definition);
        const history = normalized.runs
          .map((run): HarnessRun => {
            const message = {
              message_id: run.messageId ?? "",
              thread_id: run.threadId ?? "",
              run_id: null,
              created_at: run.startedAt ?? run.scheduledAt,
            };
            return {
              ...executionRun(
                environmentId,
                message,
                evidence.get(`${run.threadId}\0${run.messageId}`),
              ),
              key: run.id,
              expectedAt: run.scheduledAt,
              requestedAt: run.startedAt ?? run.scheduledAt,
              finishedAt: run.finishedAt,
              threads: run.threadId
                ? [
                    evidence.get(`${run.threadId}\0${run.messageId}`)?.link ??
                      threadLink(environmentId, run.threadId, null, run.messageId ?? null),
                  ]
                : [],
            };
          })
          .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
        addAutomation(
          {
            id: normalized.id,
            projectId,
            name: normalized.name,
            enabled: normalized.enabled,
            ...(normalized.ownerThreadId ? { ownerThreadId: normalized.ownerThreadId } : {}),
            triggers: [{ type: "schedule", schedule: normalized.schedule }],
            actions: [{ type: "agent", target: normalized.target, prompt: normalized.prompt }],
            nextRunAt: normalized.nextRunAt,
            createdAt,
            updatedAt: createdAt,
          },
          history,
          history.filter((run) => ["queued", "running"].includes(run.outcome)),
          "legacy-automations",
        );
      }
      for (const task of tasks.filter((task) => include(ProjectId.make(task.project_id)))) {
        const purpose = membership(task.thread_id);
        if (purpose === "project") continue;
        const history = (taskHistories.get(task.task_id) ?? []).map((message) =>
          executionRun(
            environmentId,
            message,
            evidence.get(`${message.thread_id}\0${message.message_id}`),
          ),
        );
        const activeRuns = (taskActive.get(task.task_id) ?? []).map((message) =>
          executionRun(
            environmentId,
            message,
            evidence.get(`${message.thread_id}\0${message.message_id}`),
          ),
        );
        const schedule = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ScheduledTaskSchedule),
        )(task.schedule_json);
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const next = (after: string) => {
          const at = nextScheduledRunAt(
            schedule,
            DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(after), zone),
          );
          return at ? DateTime.formatIso(at) : null;
        };
        const pending = task.next_run_at;
        // Dispatch timestamps do not prove expected fixed-time slots. Only a pending overdue slot is exact.
        const late = lateness({
          enabled: task.enabled === 1,
          now: generatedAt,
          nextRunAt: pending,
          windowStart: pending,
          next,
          runs: [],
          graceMs,
        });
        rows.push(
          routine({
            key: `${environmentId}:scheduled-task:${task.task_id}`,
            agentKey: task.thread_id
              ? `${environmentId}:thread:${task.thread_id}`
              : `${environmentId}:scheduled-task:${task.task_id}`,
            name: task.title,
            whatItChecks: task.prompt.slice(0, 4000),
            environmentId,
            projectId: ProjectId.make(task.project_id),
            owner: task.thread_id ? threadLink(environmentId, task.thread_id) : null,
            purpose: purpose === "harness" ? "harness" : "unclassified",
            source: "scheduled-tasks",
            sourceStale: sources.some(
              (source) =>
                [
                  "scheduled-tasks",
                  "threads",
                  "purpose",
                  `task-runs:${task.task_id}`,
                  `task-active:${task.task_id}`,
                  "execution-evidence",
                ].includes(source.key) && source.status !== "available",
            ),
            state: !task.enabled
              ? "disabled"
              : task.last_run_status === "failed" || history[0]?.outcome === "failed"
                ? "failing"
                : "enabled",
            lastDispatch: task.last_run_at
              ? {
                  key: `${task.task_id}:dispatch:${task.last_run_at}`,
                  requestedAt: task.last_run_at,
                  expectedAt: null,
                  startedAt: null,
                  finishedAt: null,
                  outcome:
                    task.last_run_status === "failed"
                      ? "failed"
                      : task.last_run_status === "skipped"
                        ? "skipped"
                        : "unknown",
                  outcomeKind: "dispatch",
                  dryRun: false,
                  errorCount: null,
                  runtimeErrorCount: null,
                  evidence:
                    "Saved dispatch receipt only; succeeded is not execution success. No message/run association is inferred from timestamps.",
                  threads: [],
                }
              : null,
            lifecycle: task.thread_id
              ? threads.some((thread) => thread.thread_id === task.thread_id)
                ? threads.find((thread) => thread.thread_id === task.thread_id)?.bounded === 1
                  ? "conditional"
                  : "standing"
                : null
              : "conditional",
            context: task.thread_id ? "persistent" : "new-instance-per-run",
            scheduleOrTrigger: `${encodeJson(schedule)}; server zone ${zone}`,
            nextExpectedRun: task.enabled ? pending : null,
            lateness: {
              ...late,
              evidence: `${late.evidence} Historical dispatch receipts have no expected-slot tag; coalesced historical gaps unknown. Dispatch counter ${task.run_count} is not successful executions.`,
            },
            liveness: live(
              task.thread_id,
              activeRuns,
              sources.find((source) => source.key === `task-active:${task.task_id}`)?.status ===
                "available",
            ),
            history: history.slice(0, limit),
            activeRuns,
          }),
        );
      }
      const feeds = new Map<FeedFile, FeedRead>();
      for (const filename of FEED_FILES) {
        const readAt = yield* iso();
        const feed = yield* Effect.tryPromise(() =>
          readFeed(
            directory || null,
            filename,
            readAt,
            filename === "canary-policy.json"
              ? Number.MAX_SAFE_INTEGER
              : filename === "availability.json"
                ? Math.min(staleMs, 90_000)
                : staleMs,
          ),
        );
        feeds.set(filename, feed);
        sources.push(feed.source);
      }
      sources.push({
        key: "registry",
        readAt: yield* iso(),
        observedAt: null,
        status: "available",
        evidence:
          "Static owner admission: watchdog W disabled; other checks unadmitted without typed receipts.",
      });
      rows.push(...feedRoutines(feeds, environmentId, hosts, limit));
      for (const failed of sources.filter(
        (source) =>
          ["automations", "legacy-automations", "scheduled-tasks"].includes(source.key) &&
          source.status !== "available",
      ))
        rows.push(
          routine({
            key: `${environmentId}:unavailable:${failed.key}`,
            name: `${failed.key}: not shown yet`,
            environmentId,
            source: failed.key,
            sourceStale: true,
            state: "not shown yet",
            scheduleOrTrigger: failed.evidence,
          }),
        );
      const findings = findingsReceipts(feeds.get("run-receipts.json"));
      const filtered = rows
        .filter((row) => input.routineKeys === undefined || input.routineKeys.includes(row.key))
        .map((row) =>
          routine({
            ...row,
            ...(row.sourceStale && row.state !== "disabled"
              ? {
                  state: "unknown" as const,
                  lateness: {
                    ...row.lateness,
                    state: "unknown" as const,
                    overdue: null,
                    since: null,
                    latenessMs: null,
                    evidence:
                      "Source read unavailable or stale; schedule lateness cannot be established.",
                  },
                  liveness: "unknown" as const,
                }
              : {}),
            history: row.history.map((run) => ({
              ...run,
              errorCount: findings.get(`${row.key}\0${run.key}`) ?? null,
            })),
          }),
        );
      const standing: HarnessAgent[] = threads
        .filter(
          (thread) =>
            membership(thread.thread_id) === "harness" &&
            include(ProjectId.make(thread.project_id)) &&
            !(byId.has(thread.thread_id)
              ? byId.get(thread.thread_id)?.parentThreadId
              : thread.relationship === "subagent"
                ? thread.parent
                : null) &&
            !byId.get(thread.thread_id)?.remoteParent &&
            input.routineKeys === undefined,
        )
        .map((thread) => ({
          key: `${environmentId}:thread:${thread.thread_id}`,
          name: thread.title,
          environmentId,
          lifecycle: thread.bounded === 1 ? "conditional" : "standing",
          context: "persistent",
          thread: threadLink(environmentId, thread.thread_id),
          routineKeys: [],
          liveness: live(thread.thread_id, []),
        }));
      return {
        schemaVersion: 1 as const,
        environmentId,
        generatedAt,
        sources,
        agents: groupAgents(
          filtered,
          standing,
          new Map(
            threads.map((thread) => [`${environmentId}:thread:${thread.thread_id}`, thread.title]),
          ),
        ),
        routines: filtered,
      };
    },
    Effect.mapError(() => new HarnessReadError({ message: "Harness snapshot could not be read." })),
  );
  // One bounded cache, keyed by input and a one-second freshness bucket; no timer or background polling.
  let cached: { key: string; value: HarnessSnapshot } | undefined;
  return HarnessReadService.of({
    snapshot: (input) =>
      Effect.gen(function* () {
        const validated = yield* Schema.decodeUnknownEffect(HarnessSnapshotInput)(input);
        const now = yield* DateTime.now;
        const key = encodeJson([Math.floor(DateTime.toEpochMillis(now) / 1000), validated]);
        const previous = cached;
        if (previous && previous.key === key) return previous.value;
        const value = yield* readSnapshot(validated);
        cached = { key, value };
        return value;
      }).pipe(
        Effect.mapError(
          () => new HarnessReadError({ message: "Harness snapshot could not be read." }),
        ),
      ),
  });
});
export const layer = Layer.effect(HarnessReadService, make).pipe(
  Layer.provide(AutomationStore.layer),
);
