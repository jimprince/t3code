import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  MessageId,
  EventId,
  type Automation,
  type AutomationRun,
  type HarnessRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AutomationStore from "../automations/AutomationStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { writeMetadata } from "../forkThreads/MetadataStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { nextScheduledRun } from "../automations/schedule.ts";
import { executionEvidence, make, taskMessages } from "./HarnessReadService.ts";
import { groupAgents, lateness, routine, threadLink } from "./model.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ENV = EnvironmentId.make("test-environment");
const PROJECT = ProjectId.make("project");
const NOW = "2026-10-11T06:00:00.000Z";
const RUN: HarnessRun = {
  key: "run",
  requestedAt: NOW,
  expectedAt: null,
  startedAt: NOW,
  finishedAt: NOW,
  outcome: "completed",
  outcomeKind: "execution",
  dryRun: false,
  errorCount: null,
  runtimeErrorCount: null,
  evidence: "test",
  threads: [],
};
const db = Layer.mergeAll(
  AutomationStore.layer,
  ProjectStore.layer,
  Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(ENV) }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const withDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect.pipe(Effect.provide(db)));
const hourly = [
  { type: "schedule" as const, schedule: { kind: "hourly" as const, timeZone: "UTC" } },
];
function late(enabled: boolean, nextRunAt: string, runs: readonly HarnessRun[] = []) {
  return lateness({
    enabled,
    now: NOW,
    nextRunAt,
    windowStart: nextRunAt,
    next: (after) => nextScheduledRun(hourly, after),
    runs,
    graceMs: 0,
  });
}
const insertThread = (sql: SqlClient.SqlClient, id: string, project = PROJECT) =>
  sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, ${project}, 'Same title', 'codex', 'full-access', 'default', ${NOW}, ${NOW}, '{}')`;
const insertMessage = (
  sql: SqlClient.SqlClient,
  id: string,
  thread: string,
  run: string,
  tag: string,
  at = NOW,
) =>
  sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (${id}, ${thread}, ${run}, 'user', 0, ${at}, ${at}, ${encodeJson({ scheduledTaskId: tag })})`;
const insertRun = (
  sql: SqlClient.SqlClient,
  id: string,
  thread: string,
  message: string,
  status = "completed",
) =>
  sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (${id}, ${thread}, 1, 'codex', ${status}, ${NOW}, ${status === "running" ? null : NOW}, ${encodeJson({ userMessageId: message, startedAt: NOW })})`;
const insertItem = (
  sql: SqlClient.SqlClient,
  id: string,
  thread: string,
  run: string,
  type: string,
) =>
  sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${id}, ${thread}, ${run}, 1, ${type}, 'completed', ${NOW}, '{}')`;

it.layer(NodeServices.layer)("Harness production read model", (it) => {
  it.effect("groups persistent schedules together and per-run threads into one agent row", () =>
    Effect.sync(() => {
      const a = routine({
        key: "a",
        agentKey: `${ENV}:automation:rule`,
        name: "Sweep",
        environmentId: ENV,
        source: "automations",
        lifecycle: "conditional",
        context: "new-instance-per-run",
        liveness: "not currently live",
        history: [
          { ...RUN, threads: [threadLink(ENV, "old-1")] },
          { ...RUN, key: "other", threads: [threadLink(ENV, "old-2")] },
        ],
      });
      const b = routine({
        key: "b",
        agentKey: `${ENV}:thread:head`,
        name: "Head",
        environmentId: ENV,
        source: "automations",
        lifecycle: "standing",
        context: "persistent",
        liveness: "not currently live",
      });
      const c = routine({ ...b, key: "c", liveness: "active" });
      const agents = groupAgents([a, b, c]);
      expect(agents).toHaveLength(2);
      expect(agents.find((agent) => agent.key === a.agentKey)).toMatchObject({
        context: "new-instance-per-run",
        thread: null,
        liveness: "not currently live",
        routineKeys: ["a"],
      });
      expect(agents.find((agent) => agent.key === b.agentKey)).toMatchObject({
        routineKeys: ["b", "c"],
        liveness: "active",
      });
    }),
  );
  it.effect("disabled stale nextRunAt is never overdue", () =>
    Effect.sync(() => {
      expect(late(false, "2026-10-10T01:00:00.000Z")).toMatchObject({
        state: "disabled",
        overdue: false,
        missedSlots: null,
      });
    }),
  );
  it.effect("counts coalesced missed slots and distinguishes future first runs", () =>
    Effect.sync(() => {
      expect(
        late(true, "2026-10-11T03:00:00.000Z", [
          { ...RUN, expectedAt: "2026-10-11T03:00:00.000Z" },
        ]),
      ).toMatchObject({ state: "overdue", missedSlots: 3, sampleSize: 4 });
      expect(
        late(true, "2026-10-11T07:00:00.000Z", [
          { ...RUN, expectedAt: "2026-10-10T06:00:00.000Z" },
        ]),
      ).toMatchObject({ state: "on-time", overdue: false });
      expect(late(true, "2026-10-11T07:00:00.000Z")).toMatchObject({
        state: "on-time",
        overdue: false,
        missedSlots: 0,
      });
    }),
  );
  it.effect(
    "dispatch without execution is unknown, while exact queued executions expose late starts",
    () =>
      Effect.sync(() => {
        const queued = {
          ...RUN,
          requestedAt: "2026-10-11T06:00:00.000Z",
          expectedAt: "2026-10-11T06:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          outcome: "queued" as const,
        };
        expect(late(true, "2026-10-11T06:00:00.000Z", [queued])).toMatchObject({
          state: "overdue",
          phase: "start",
          overdue: true,
        });
        expect(
          late(true, "2026-10-11T06:00:00.000Z", [{ ...queued, outcomeKind: "dispatch" }]),
        ).toMatchObject({ state: "unknown", overdue: null });
      }),
  );
  it.effect("calendar slot evidence survives fall DST repetition", () =>
    Effect.sync(() => {
      const triggers = [
        {
          type: "schedule" as const,
          schedule: { kind: "hourly" as const, timeZone: "America/Edmonton" },
        },
      ];
      const result = lateness({
        enabled: true,
        now: "2026-11-01T10:00:00.000Z",
        nextRunAt: "2026-11-01T07:00:00.000Z",
        windowStart: "2026-11-01T07:00:00.000Z",
        next: (after) => nextScheduledRun(triggers, after),
        runs: [],
        graceMs: 0,
      });
      expect(result.sampleSize).toBe(4);
      expect(result.missedSlots).toBe(4);
    }),
  );
  it.effect(
    "unknown findings stay unknown and dispatch successes do not enter execution trends",
    () =>
      Effect.sync(() => {
        const row = routine({
          key: "a",
          name: "Check",
          environmentId: ENV,
          source: "automations",
          history: [
            RUN,
            { ...RUN, key: "dispatch", outcomeKind: "dispatch" },
            { ...RUN, key: "dry", dryRun: true },
            { ...RUN, key: "fail", outcome: "failed", runtimeErrorCount: 2 },
          ],
        });
        expect(row.errorsPerRun).toMatchObject({
          sampleSize: 2,
          knownSamples: 0,
          average: null,
          recent: [null, null],
        });
        expect(row.runtimeErrorsPerRun).toMatchObject({
          knownSamples: 1,
          missingSamples: 1,
          average: 2,
        });
        expect(row.failedExecutions).toEqual({ sampleSize: 2, failures: 1, rate: 0.5 });
      }),
  );
  it.effect(
    "task history is exact per tag and project even beyond a newest-100 global window",
    () =>
      withDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* insertThread(sql, "old");
          yield* insertThread(sql, "noise");
          yield* insertThread(sql, "foreign", ProjectId.make("foreign"));
          yield* insertMessage(sql, "wanted", "old", "run-old", "task", "2026-10-01T01:00:00.000Z");
          for (let index = 0; index < 110; index++)
            yield* insertMessage(sql, `noise-${index}`, "noise", `noise-run-${index}`, "other");
          yield* insertMessage(sql, "foreign", "foreign", "foreign-run", "task");
          const rows = yield* taskMessages(
            sql,
            { task_id: "task", project_id: PROJECT, thread_id: null },
            10,
          );
          expect(rows.map((row) => row.message_id)).toEqual(["wanted"]);
          const plan = yield* sql<{
            detail: string;
          }>`EXPLAIN QUERY PLAN SELECT message_id FROM orchestration_v2_projection_messages WHERE role = 'user' AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.scheduledTaskId') END = 'task' ORDER BY created_at DESC, message_id DESC LIMIT 10`;
          expect(
            plan.some((entry) => entry.detail.includes("fork_harness_task_messages_idx")),
          ).toBe(true);
        }),
      ),
  );
  it.effect("an older active task run survives the bounded history window", () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertThread(sql, "active");
        yield* insertThread(sql, "finished");
        yield* insertMessage(
          sql,
          "active-msg",
          "active",
          "active-run",
          "task",
          "2026-10-01T01:00:00.000Z",
        );
        yield* insertRun(sql, "active-run", "active", "active-msg", "running");
        yield* insertMessage(sql, "latest-msg", "finished", "latest-run", "task");
        expect(
          (yield* taskMessages(
            sql,
            { task_id: "task", project_id: PROJECT, thread_id: null },
            1,
          )).map((row) => row.message_id),
        ).toEqual(["latest-msg"]);
        expect(
          (yield* taskMessages(
            sql,
            { task_id: "task", project_id: PROJECT, thread_id: null },
            1,
            true,
          )).map((row) => row.message_id),
        ).toEqual(["active-msg"]);
      }),
    ),
  );
  it.effect(
    "exact root joins exclude child errors, wrong messages and unavailable item signals",
    () =>
      withDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* insertThread(sql, "root");
          yield* insertThread(sql, "child");
          yield* insertThread(sql, "empty");
          yield* insertMessage(sql, "root-msg", "root", "root-run", "task");
          yield* insertRun(sql, "root-run", "root", "root-msg");
          yield* insertItem(sql, "root-error", "root", "root-run", "error");
          yield* insertItem(sql, "child-error", "child", "child-run", "error");
          yield* insertMessage(sql, "empty-msg", "empty", "empty-run", "task");
          yield* insertRun(sql, "empty-run", "empty", "empty-msg");
          yield* insertMessage(sql, "wrong-msg", "root", "root-run", "task");
          const result = yield* executionEvidence(sql, [
            threadLink(ENV, "root", null, "root-msg"),
            threadLink(ENV, "empty", null, "empty-msg"),
            threadLink(ENV, "root", null, "wrong-msg"),
          ]);
          expect(result.get("root\0root-msg")?.errors).toBe(1);
          expect(result.get("empty\0empty-msg")?.errors).toBeNull();
          expect(result.get("root\0wrong-msg")?.execution).toBeNull();
        }),
      ),
  );
  it.effect(
    "snapshot reads both stores, keeps ownership unknown, excludes Projects and ignores disabled next times",
    () =>
      withDb(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const sql = yield* SqlClient.SqlClient;
          const store = yield* AutomationStore.AutomationStore;
          const projects = yield* ProjectStore.ProjectStoreV2;
          yield* projects.apply({
            sequence: 1,
            eventId: EventId.make("created"),
            aggregateKind: "project",
            aggregateId: PROJECT,
            occurredAt: NOW,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: PROJECT,
              title: "Test",
              workspaceRoot: "/tmp/harness-test",
              defaultModelSelection: null,
              scripts: [],
              createdAt: NOW,
              updatedAt: NOW,
            },
          });
          for (const id of ["harness-owner", "project-owner"]) yield* insertThread(sql, id);
          yield* writeMetadata(sql, {
            threadId: ThreadId.make("harness-owner"),
            parentThreadId: null,
            purpose: "harness",
          });
          yield* writeMetadata(sql, {
            threadId: ThreadId.make("project-owner"),
            parentThreadId: null,
            purpose: "project",
          });
          const definition: Automation = {
            id: "rule",
            projectId: PROJECT,
            name: "Check",
            enabled: false,
            ownerThreadId: ThreadId.make("harness-owner"),
            triggers: hourly,
            actions: [{ type: "agent", prompt: "Check tools", target: { kind: "new-thread" } }],
            nextRunAt: "2026-10-10T00:00:00.000Z",
            createdAt: NOW,
            updatedAt: NOW,
          };
          yield* store.saveAutomation(definition);
          yield* store.saveAutomation({
            ...definition,
            id: "unknown-owner",
            ownerThreadId: ThreadId.make("missing-owner"),
          });
          yield* store.saveAutomation({
            ...definition,
            id: "project-rule",
            ownerThreadId: ThreadId.make("project-owner"),
          });
          const run: AutomationRun = {
            id: "dispatch-only",
            automationId: "rule",
            projectId: PROJECT,
            name: "Check",
            dedupeKey: "once",
            trigger: { kind: "manual" },
            dryRun: false,
            status: "completed",
            result: "Dispatched",
            steps: [
              {
                kind: "agent",
                status: "completed",
                target: { kind: "new-thread" },
                threadId: ThreadId.make("missing-run-thread"),
                messageId: MessageId.make("missing-message"),
                title: "Same title",
                prompt: "Check",
                result: null,
                startedAt: NOW,
                finishedAt: NOW,
              },
            ],
            createdAt: NOW,
            finishedAt: NOW,
          };
          yield* store.insertRun(run);
          yield* sql`UPDATE projection_projects SET automations_json = ${encodeJson([{ id: "legacy", name: "Old check", ownerThreadId: "harness-owner", schedule: { kind: "hourly", timeZone: "UTC" }, prompt: "Check", target: { kind: "existing-thread", threadId: "harness-owner" }, enabled: false, nextRunAt: "2026-10-10T00:00:00.000Z", runs: [] }])} WHERE project_id = ${PROJECT}`;
          yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, next_run_at, last_run_at, last_run_status, run_count) VALUES ('task', 'Same title', 'Check Harness', 1, '{"type":"interval","everyMs":3600000}', ${PROJECT}, 'harness-owner', '{"type":"root"}', '{"instanceId":"codex","model":"gpt-6.1-sol"}', 'full-access', 'default', 'agent', 'mcp', ${NOW}, ${NOW}, '2026-10-11T07:00:00.000Z', ${NOW}, 'failed', 3)`;
          yield* insertMessage(sql, "task-message", "harness-owner", "task-execution", "task");
          yield* insertRun(sql, "task-execution", "harness-owner", "task-message");
          yield* insertItem(sql, "task-output", "harness-owner", "task-execution", "message");
          const service = yield* make;
          const snapshot = yield* service.snapshot({});
          expect(
            snapshot.routines.find((row) => row.key.endsWith(":automations:rule")),
          ).toMatchObject({
            nextExpectedRun: null,
            lateness: { overdue: false },
            lastRun: { outcome: "unknown", outcomeKind: "dispatch", errorCount: null },
          });
          expect(
            snapshot.routines.find((row) => row.key.endsWith(":legacy-automations:legacy")),
          ).toMatchObject({ context: "persistent", state: "disabled" });
          expect(
            snapshot.routines.find((row) => row.key.endsWith(":automations:unknown-owner"))
              ?.purpose,
          ).toBe("unclassified");
          expect(snapshot.routines.some((row) => row.key.endsWith(":project-rule"))).toBe(false);
          expect(snapshot.routines.find((row) => row.key.endsWith(":watchdog:240"))).toMatchObject({
            state: "disabled",
            lateness: { overdue: false },
          });
          expect(
            snapshot.routines.find((row) => row.key.endsWith(":scheduled-task:task")),
          ).toMatchObject({
            state: "failing",
            lastRun: {
              outcome: "completed",
              outcomeKind: "execution",
              errorCount: null,
              runtimeErrorCount: 0,
            },
            lastDispatch: { outcome: "failed", outcomeKind: "dispatch" },
          });
          expect(snapshot.sources.every((source) => source.readAt.length > 0)).toBe(true);
          expect(
            snapshot.routines.find((row) => row.name === "Other bots, cron and timers")?.state,
          ).toBe("not shown yet");
        }),
      ),
  );
});
