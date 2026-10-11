import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Optional acceleration only; admission requires startup timing on a real-size DB copy. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS fork_harness_task_messages_idx ON orchestration_v2_projection_messages (
    thread_id,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.scheduledTaskId') END,
    created_at DESC, message_id DESC
  ) WHERE role = 'user'`;
});
