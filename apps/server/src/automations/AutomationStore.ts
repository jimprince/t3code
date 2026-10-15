import {
  Automation,
  AutomationError,
  AutomationRun,
  AutomationScript,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

/** Finished runs kept per automation; active runs are never pruned. */
const RUN_HISTORY = 50;

const AutomationJson = Schema.fromJsonString(Automation);
const RunJson = Schema.fromJsonString(AutomationRun);
const ScriptJson = Schema.fromJsonString(AutomationScript);
const decodeAutomation = Schema.decodeUnknownEffect(AutomationJson);
const decodeRun = Schema.decodeUnknownEffect(RunJson);
const decodeScript = Schema.decodeUnknownEffect(ScriptJson);
const encodeAutomation = Schema.encodeSync(AutomationJson);
const encodeRun = Schema.encodeSync(RunJson);
const encodeScript = Schema.encodeSync(ScriptJson);

const storageError = (cause: unknown) =>
  new AutomationError({
    message: `Automation storage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

type Fx<A> = Effect.Effect<A, AutomationError>;

/** Plain rows for scripts, automations and runs. Nothing here depends on orchestration. */
export class AutomationStore extends Context.Service<
  AutomationStore,
  {
    readonly listAutomations: (projectId?: ProjectId) => Fx<ReadonlyArray<Automation>>;
    readonly getAutomation: (id: string) => Fx<Option.Option<Automation>>;
    readonly saveAutomation: (automation: Automation, writeRoutineKind?: boolean) => Fx<void>;
    /** Inserts unless the id was ever stored, including a deleted tombstone. */
    readonly insertAutomationOnce: (automation: Automation) => Fx<boolean>;
    readonly deleteAutomation: (id: string, deletedAt: string) => Fx<void>;
    readonly listScripts: (projectId: ProjectId | null) => Fx<ReadonlyArray<AutomationScript>>;
    readonly getScript: (id: string) => Fx<Option.Option<AutomationScript>>;
    /** A project script shadows a global script of the same name. */
    readonly findScript: (
      projectId: ProjectId,
      name: string,
    ) => Fx<Option.Option<AutomationScript>>;
    readonly saveScript: (script: AutomationScript) => Fx<void>;
    readonly deleteScript: (id: string) => Fx<void>;
    /** False when the automation already has a run with this dedupe key. */
    readonly insertRun: (run: AutomationRun) => Fx<boolean>;
    readonly getRun: (id: string) => Fx<Option.Option<AutomationRun>>;
    readonly saveRun: (run: AutomationRun) => Fx<void>;
    readonly activeRuns: Fx<ReadonlyArray<AutomationRun>>;
    readonly listRuns: (input: {
      automationId?: string;
      projectId?: ProjectId;
      limit: number;
    }) => Fx<ReadonlyArray<AutomationRun>>;
    /** Last value an event source saw under a state key. */
    readonly getState: (key: string) => Fx<string | undefined>;
    readonly setState: (key: string, value: string, now: string) => Fx<void>;
    readonly transaction: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | AutomationError>;
  }
>()("t3/automations/AutomationStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(storageError));
  const automations = (rows: ReadonlyArray<{ readonly json: string }>) =>
    fail(Effect.forEach(rows, (row) => decodeAutomation(row.json)));
  const runs = (rows: ReadonlyArray<{ readonly json: string }>) =>
    fail(Effect.forEach(rows, (row) => decodeRun(row.json)));
  const scripts = (rows: ReadonlyArray<{ readonly json: string }>) =>
    fail(Effect.forEach(rows, (row) => decodeScript(row.json)));

  const listAutomations = (projectId?: ProjectId) =>
    fail(
      projectId === undefined
        ? sql<{ json: string }>`
            SELECT automation_json AS json FROM automations
            WHERE deleted_at IS NULL ORDER BY created_at, automation_id`
        : sql<{ json: string }>`
            SELECT automation_json AS json FROM automations
            WHERE deleted_at IS NULL AND project_id = ${projectId}
            ORDER BY created_at, automation_id`,
    ).pipe(Effect.flatMap(automations));

  const getAutomation = (id: string) =>
    fail(
      sql<{ json: string }>`
        SELECT automation_json AS json FROM automations
        WHERE automation_id = ${id} AND deleted_at IS NULL`,
    ).pipe(
      Effect.flatMap(automations),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const saveAutomation = (automation: Automation, writeRoutineKind = false) =>
    fail(sql`
      INSERT INTO automations (automation_id, project_id, automation_json, created_at, updated_at)
      VALUES (${automation.id}, ${automation.projectId}, ${encodeAutomation(automation)},
              ${automation.createdAt}, ${automation.updatedAt})
      ON CONFLICT (automation_id) DO UPDATE SET
        project_id = excluded.project_id,
        automation_json = CASE WHEN ${writeRoutineKind ? 1 : 0} = 1 THEN excluded.automation_json
          WHEN json_type(automations.automation_json, '$.routineKind') IS NULL
            THEN json_remove(excluded.automation_json, '$.routineKind')
          ELSE json_set(excluded.automation_json, '$.routineKind', json_extract(automations.automation_json, '$.routineKind')) END,
        updated_at = excluded.updated_at
      WHERE automations.deleted_at IS NULL
    `).pipe(Effect.asVoid);

  const insertAutomationOnce = (automation: Automation) =>
    fail(sql<{ id: string }>`
      INSERT INTO automations (automation_id, project_id, automation_json, created_at, updated_at)
      VALUES (${automation.id}, ${automation.projectId}, ${encodeAutomation(automation)},
              ${automation.createdAt}, ${automation.updatedAt})
      ON CONFLICT (automation_id) DO NOTHING
      RETURNING automation_id AS id
    `).pipe(Effect.map((rows) => rows.length > 0));

  const deleteAutomation = (id: string, deletedAt: string) =>
    fail(
      sql`UPDATE automations SET deleted_at = ${deletedAt}, updated_at = ${deletedAt}
          WHERE automation_id = ${id} AND deleted_at IS NULL`,
    ).pipe(Effect.asVoid);

  const listScripts = (projectId: ProjectId | null) =>
    fail(
      projectId === null
        ? sql<{ json: string }>`
            SELECT script_json AS json FROM automation_scripts
            WHERE project_id IS NULL ORDER BY name`
        : sql<{ json: string }>`
            SELECT script_json AS json FROM automation_scripts
            WHERE project_id = ${projectId} OR project_id IS NULL
            ORDER BY project_id IS NULL, name`,
    ).pipe(Effect.flatMap(scripts));

  const getScript = (id: string) =>
    fail(
      sql<{ json: string }>`SELECT script_json AS json FROM automation_scripts
                            WHERE script_id = ${id}`,
    ).pipe(
      Effect.flatMap(scripts),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const findScript = (projectId: ProjectId, name: string) =>
    fail(
      sql<{ json: string }>`
        SELECT script_json AS json FROM automation_scripts
        WHERE name = ${name} AND (project_id = ${projectId} OR project_id IS NULL)
        ORDER BY project_id IS NULL LIMIT 1`,
    ).pipe(
      Effect.flatMap(scripts),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const saveScript = (script: AutomationScript) =>
    fail(sql`
      INSERT INTO automation_scripts (script_id, project_id, name, script_json, created_at, updated_at)
      VALUES (${script.id}, ${script.projectId}, ${script.name}, ${encodeScript(script)},
              ${script.createdAt}, ${script.updatedAt})
      ON CONFLICT (script_id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        script_json = excluded.script_json,
        updated_at = excluded.updated_at
    `).pipe(Effect.asVoid);

  const deleteScript = (id: string) =>
    fail(sql`DELETE FROM automation_scripts WHERE script_id = ${id}`).pipe(Effect.asVoid);

  const insertRun = (run: AutomationRun) =>
    fail(
      Effect.gen(function* () {
        const inserted = yield* sql<{ id: string }>`
          INSERT INTO automation_runs
            (run_id, automation_id, project_id, dedupe_key, status, run_json, created_at)
          VALUES (${run.id}, ${run.automationId}, ${run.projectId}, ${run.dedupeKey},
                  ${run.status}, ${encodeRun(run)}, ${run.createdAt})
          ON CONFLICT DO NOTHING
          RETURNING run_id AS id
        `;
        if (inserted.length === 0) return false;
        // Virtual request keys are durable for the life of the registry entry.
        // Pruning one would allow an old retry to execute the request again.
        if (run.virtualSubhead !== undefined) return true;
        yield* sql`
          DELETE FROM automation_runs
          WHERE automation_id = ${run.automationId}
            AND status NOT IN ('queued', 'running')
            AND run_id NOT IN (
              SELECT run_id FROM automation_runs
              WHERE automation_id = ${run.automationId} AND status NOT IN ('queued', 'running')
              ORDER BY created_at DESC LIMIT ${RUN_HISTORY}
            )
        `;
        return true;
      }),
    );

  const saveRun = (run: AutomationRun) =>
    fail(
      sql`UPDATE automation_runs SET status = ${run.status}, run_json = ${encodeRun(run)}
          WHERE run_id = ${run.id}`,
    ).pipe(Effect.asVoid);

  const getRun = (id: string) =>
    fail(
      sql<{ json: string }>`SELECT run_json AS json FROM automation_runs WHERE run_id=${id}`,
    ).pipe(
      Effect.flatMap(runs),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const activeRuns = fail(
    sql<{ json: string }>`
      SELECT run_json AS json FROM automation_runs
      WHERE status IN ('queued', 'running') ORDER BY created_at, rowid`,
  ).pipe(Effect.flatMap(runs));

  const listRuns = (input: { automationId?: string; projectId?: ProjectId; limit: number }) =>
    fail(
      input.automationId !== undefined
        ? sql<{ json: string }>`
            SELECT run_json AS json FROM automation_runs WHERE automation_id = ${input.automationId} AND json_type(run_json,'$.virtualSubhead') IS NULL
            ORDER BY created_at DESC, run_id DESC LIMIT ${input.limit}`
        : input.projectId !== undefined
          ? sql<{ json: string }>`
              SELECT run_json AS json FROM automation_runs WHERE project_id = ${input.projectId} AND json_type(run_json,'$.virtualSubhead') IS NULL
              ORDER BY created_at DESC, run_id DESC LIMIT ${input.limit}`
          : sql<{ json: string }>`
              SELECT run_json AS json FROM automation_runs WHERE json_type(run_json,'$.virtualSubhead') IS NULL
              ORDER BY created_at DESC, run_id DESC LIMIT ${input.limit}`,
    ).pipe(Effect.flatMap(runs));

  const getState = (key: string) =>
    fail(
      sql<{ value: string }>`SELECT value FROM automation_source_state WHERE state_key = ${key}`,
    ).pipe(Effect.map((rows) => rows[0]?.value));

  const setState = (key: string, value: string, now: string) =>
    fail(sql`
      INSERT INTO automation_source_state (state_key, value, updated_at)
      VALUES (${key}, ${value}, ${now})
      ON CONFLICT (state_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).pipe(Effect.asVoid);

  return AutomationStore.of({
    getState,
    setState,
    listAutomations,
    getAutomation,
    saveAutomation,
    insertAutomationOnce,
    deleteAutomation,
    listScripts,
    getScript,
    findScript,
    saveScript,
    deleteScript,
    insertRun,
    getRun,
    saveRun,
    activeRuns,
    listRuns,
    transaction: (effect) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.mapError((error) => (SqlError.isSqlError(error) ? storageError(error) : error)),
        ),
  });
});

export const layer = Layer.effect(AutomationStore, make);
