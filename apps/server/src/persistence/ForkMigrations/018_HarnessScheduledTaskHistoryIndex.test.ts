import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { taskMessages, taskQuery } from "../../harness/HarnessReadService.ts";
import Migration0018 from "./018_HarnessScheduledTaskHistoryIndex.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(SqlitePersistenceMemory)("optional Harness task history index", (it) => {
  it.effect("preserves exact bounded histories and active joins with or without the index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP INDEX fork_harness_task_messages_idx`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread', 'project', 'Same title', 'codex', 'full-access', 'default', '2026-10-11', '2026-10-11', '{}')`;
      for (let i = 0; i < 50; i++) {
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (${`message-${i}`}, 'thread', ${`run-${i}`}, 'user', 0, '2026-10-11', '2026-10-11', ${encodeJson({ scheduledTaskId: i % 2 ? "task" : "other" })})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${`run-${i}`}, 'thread', ${i + 1}, 'codex', 'running', '2026-10-11', ${encodeJson({ userMessageId: `message-${i}` })})`;
      }
      const task = { task_id: "task", project_id: "project", thread_id: null };
      const before = yield* taskMessages(sql, task, 10);
      const activeBefore = yield* taskMessages(sql, task, 10, true);
      expect(before.messages).toHaveLength(10);
      expect(activeBefore.messages).toHaveLength(25);
      yield* Migration0018;
      yield* Migration0018;
      expect(yield* taskMessages(sql, task, 10)).toEqual(before);
      expect(yield* taskMessages(sql, task, 10, true)).toEqual(activeBefore);
      const [text, params] = taskQuery.history(sql, "task", "thread", 10).compile();
      const plan = yield* sql.unsafe<{ detail: string }>("EXPLAIN QUERY PLAN " + text, params);
      expect(plan.some((entry) => entry.detail.includes("fork_harness_task_messages_idx"))).toBe(
        true,
      );
    }),
  );
});
