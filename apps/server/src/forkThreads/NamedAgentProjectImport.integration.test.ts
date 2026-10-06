import { assertFixtureMigration16 } from "../persistence/fixtureMigration16.testkit.ts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EventId,
  NamedAgentName,
  PermanentAgent,
  ProjectAutomation,
  ProjectId,
  ProjectScript,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

it.effect("fresh databases register named-agent and project-automation migration IDs once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* sql<{
      migration_id: number;
    }>`SELECT migration_id FROM effect_sql_fork_migrations WHERE migration_id IN (9,10) ORDER BY migration_id`;
    assert.deepEqual(
      ids.map((row) => row.migration_id),
      [9, 10],
    );
    assert.deepEqual(yield* runForkMigrations(), []);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
if (fixtures) {
  it.effect.each(["dev-vm", "local-mbp", "synthetic-edges", "dev-vm-real"])(
    "preserves named agents, legacy automation records and scripts from copied %s projects",
    (name) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: process.env.T3_AUTOMATION_TEST_TMP,
          prefix: "project-import-",
        });
        const copy = path.join(temporary, "state.sqlite");
        yield* fs.copyFile(
          path.join(
            fixtures,
            name === "dev-vm-real" ? "dev-vm.sqlite" : `${name}.small.sanitized.sqlite`,
          ),
          copy,
        );
        const database = NodeSqliteClient.layer({ filename: copy });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const readRows = () =>
            sql<{
              project_id: string;
              permanent_agent_json: string | null;
              automations_json: string;
              scripts_json: string;
            }>`SELECT project_id, permanent_agent_json, automations_json, scripts_json FROM projection_projects ORDER BY project_id`;
          const before = yield* readRows();
          const ledger =
            yield* sql`SELECT migration_id,name FROM effect_sql_fork_migrations WHERE migration_id IN (9,10) ORDER BY migration_id`;
          yield* assertFixtureMigration16;
          assert.deepEqual(yield* readRows(), before);
          assert.deepEqual(
            yield* sql`SELECT migration_id,name FROM effect_sql_fork_migrations WHERE migration_id IN (9,10) ORDER BY migration_id`,
            ledger,
          );
          // Repair sanitizer-generated UUID instance IDs only in our disposable copies.
          // The real VM copy is read with its original provider IDs and model selections.
          if (name !== "dev-vm-real") {
            yield* sql`UPDATE projection_projects
              SET default_model_selection_json = json_set(default_model_selection_json, '$.instanceId', 'codex')
              WHERE default_model_selection_json IS NOT NULL`;
          }
          const projects = yield* ProjectStore.make;
          const nativeRows = yield* projects.list({ includeDeleted: true });
          assert.equal(nativeRows.length, before.length);
          for (const row of nativeRows) {
            yield* projects.getShell(row.projectId);
            yield* projects.get(row.projectId, { includeDeleted: true });
          }
          assert.deepEqual(yield* readRows(), before);
          assert.deepEqual(yield* runForkMigrations(), []);
          for (const row of before) {
            if (row.permanent_agent_json !== null)
              yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PermanentAgent))(
                row.permanent_agent_json,
              );
            yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(ProjectAutomation)),
            )(row.automations_json);
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ProjectScript)))(
              row.scripts_json,
            );
          }
        }).pipe(Effect.provide(database));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
} else {
  it.effect.skip("copied-state fixtures require T3_LIFECYCLE_FIXTURES", () => Effect.void);
}

it.effect("native project edits retain named agents and automation records", () =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectId = ProjectId.make("owned-fields");
    const base = {
      sequence: 1,
      eventId: EventId.make("create-project"),
      aggregateKind: "project" as const,
      aggregateId: projectId,
      occurredAt: "2026-10-06T00:00:00Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    yield* projects.apply({
      ...base,
      type: "project.created",
      payload: {
        projectId,
        title: "Agent",
        workspaceRoot: "/tmp/agent",
        defaultModelSelection: null,
        scripts: [],
        createdAt: base.occurredAt,
        updatedAt: base.occurredAt,
      },
    });
    const permanentAgent = { name: NamedAgentName.make("printer") };
    const automation = {
      id: "review",
      name: "Review",
      prompt: "Review it",
      enabled: true,
      schedule: { kind: "daily" as const, time: "07:00", timeZone: "UTC" },
      target: { kind: "new-thread" as const },
      nextRunAt: "2026-10-07T07:00:00Z",
      runs: [],
    };
    yield* projects.apply({
      ...base,
      sequence: 2,
      eventId: EventId.make("set-owned-fields"),
      type: "project.meta-updated",
      payload: { projectId, permanentAgent, automations: [automation], updatedAt: base.occurredAt },
    });
    yield* projects.apply({
      ...base,
      sequence: 3,
      eventId: EventId.make("rename-project"),
      type: "project.meta-updated",
      payload: { projectId, title: "Renamed", updatedAt: base.occurredAt },
    });
    const shell = yield* projects.getShell(projectId);
    assert.equal(shell._tag, "Some");
    if (shell._tag === "Some") {
      assert.deepEqual(shell.value.permanentAgent, permanentAgent);
      assert.deepEqual(shell.value.automations, [automation]);
      assert.equal(shell.value.title, "Renamed");
    }
  }).pipe(Effect.provide(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);
