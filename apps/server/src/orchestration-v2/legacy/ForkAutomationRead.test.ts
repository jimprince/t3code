import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { readLegacyAutomationOutcome } from "./ForkAutomationRead.ts";

it.effect(
  "tracks the imported input's exact turn and checkpoint without resending or modifying historical state",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("imported-automation");
      const messageId = MessageId.make("automation:imported");
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,latest_turn_id,created_at,updated_at) VALUES (${threadId},'project','Imported','{"instanceId":"codex","model":"test"}','full-access','default','owned-turn','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at) VALUES (${messageId},${threadId},'owned-turn','user','Review',0,'2026-10-06T00:00:00Z','2026-10-06T00:00:00Z')`;
      yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES (${threadId},'owned-turn','running','2026-10-06T00:00:00Z','[]')`;
      assert.isNull(yield* readLegacyAutomationOutcome(sql, threadId, messageId));
      assert.isNull(
        yield* readLegacyAutomationOutcome(sql, threadId, MessageId.make("other-input")),
      );
      yield* sql`UPDATE projection_turns SET state='completed' WHERE thread_id=${threadId} AND turn_id='owned-turn'`;
      assert.deepEqual(yield* readLegacyAutomationOutcome(sql, threadId, messageId), {
        status: "completed",
        result: "Turn completed.",
      });
      yield* sql`UPDATE projection_threads SET latest_turn_id='another-turn' WHERE thread_id=${threadId}`;
      assert.isNull(yield* readLegacyAutomationOutcome(sql, threadId, messageId));
      yield* sql`UPDATE projection_turns SET checkpoint_turn_count=1,checkpoint_status='error' WHERE thread_id=${threadId}`;
      assert.deepEqual(yield* readLegacyAutomationOutcome(sql, threadId, messageId), {
        status: "failed",
        result: "Turn checkpoint failed.",
      });
      const before = yield* sql`SELECT * FROM projection_turns WHERE thread_id=${threadId}`;
      yield* readLegacyAutomationOutcome(sql, threadId, messageId);
      assert.deepEqual(
        yield* sql`SELECT * FROM projection_turns WHERE thread_id=${threadId}`,
        before,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
