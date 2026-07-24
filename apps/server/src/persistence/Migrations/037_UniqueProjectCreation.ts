import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A project aggregate has exactly one creation event, including across processes. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_events_unique_project_creation
    ON orchestration_events(stream_id)
    WHERE aggregate_kind = 'project' AND event_type = 'project.created'
  `;
});
