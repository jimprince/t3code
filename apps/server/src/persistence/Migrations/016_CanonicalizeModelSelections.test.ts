import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0016 from "./016_CanonicalizeModelSelections.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("016_CanonicalizeModelSelections", (it) => {
  it.effect(
    "migrates legacy projection rows and event payloads to the canonical model-selection shape",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          default_model TEXT
        )
      `;
        yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          model TEXT NOT NULL
        )
      `;
        yield* sql`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          provider_name TEXT
        )
      `;
        yield* sql`
        CREATE TABLE orchestration_events (
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;

        yield* sql`
        INSERT INTO projection_projects (project_id, default_model)
        VALUES
          ('project-codex', 'gpt-5.4'),
          ('project-claude', 'claude-sonnet-4-6'),
          ('project-null', NULL)
      `;
        yield* sql`
        UPDATE projection_projects
        SET default_model = 'claude-opus-4-6'
        WHERE project_id = 'project-claude'
      `;
        yield* sql`
        INSERT INTO projection_threads (thread_id, model)
        VALUES
          ('thread-session', 'gpt-5.4'),
          ('thread-claude', 'claude-opus-4-6'),
          ('thread-codex', 'gpt-5.4'),
          ('thread-legacy-options', 'claude-opus-4-6')
      `;
        yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, provider_name)
        VALUES ('thread-session', 'claudeAgent')
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          event_type,
          payload_json
        )
        VALUES
        (
          'project.created',
          '{"projectId":"project-1","title":"Project","workspaceRoot":"/tmp/project","defaultModel":"claude-opus-4-6","defaultModelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max"}},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}'
        ),
        (
          'thread.created',
          '{"threadId":"thread-1","projectId":"project-1","title":"Thread","model":"claude-opus-4-6","modelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max","thinking":false}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}'
        ),
        (
          'thread.turn-start-requested',
          '{"threadId":"thread-1","turnId":"turn-1","input":"hi","model":"gpt-5.4","modelOptions":{"codex":{"fastMode":true},"claudeAgent":{"effort":"max"}},"deliveryMode":"buffered"}'
        )
      `;

        yield* Migration0016;

        const projectRows = yield* sql<{
          readonly projectId: string;
          readonly defaultProvider: string | null;
        }>`
        SELECT
          project_id AS "projectId",
          default_provider AS "defaultProvider"
        FROM projection_projects
        ORDER BY project_id
      `;
        assert.deepStrictEqual(projectRows, [
          { projectId: "project-claude", defaultProvider: "claudeAgent" },
          { projectId: "project-codex", defaultProvider: "codex" },
          { projectId: "project-null", defaultProvider: null },
        ]);

        const threadRows = yield* sql<{
          readonly threadId: string;
          readonly provider: string | null;
          readonly modelOptions: string | null;
        }>`
        SELECT
          thread_id AS "threadId",
          provider,
          model_options_json AS "modelOptions"
        FROM projection_threads
        ORDER BY thread_id
      `;
        assert.deepStrictEqual(threadRows, [
          { threadId: "thread-claude", provider: "claudeAgent", modelOptions: null },
          { threadId: "thread-codex", provider: "codex", modelOptions: null },
          { threadId: "thread-legacy-options", provider: "claudeAgent", modelOptions: null },
          { threadId: "thread-session", provider: "claudeAgent", modelOptions: null },
        ]);

        const eventRows = yield* sql<{
          readonly payloadJson: string;
        }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY rowid ASC
      `;

        assert.deepStrictEqual(JSON.parse(eventRows[0]!.payloadJson), {
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
            },
          },
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        assert.deepStrictEqual(JSON.parse(eventRows[1]!.payloadJson), {
          threadId: "thread-1",
          projectId: "project-1",
          title: "Thread",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              thinking: false,
            },
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        assert.deepStrictEqual(JSON.parse(eventRows[2]!.payloadJson), {
          threadId: "thread-1",
          turnId: "turn-1",
          input: "hi",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
            options: {
              fastMode: true,
            },
          },
          deliveryMode: "buffered",
        });
      }),
  );
});
