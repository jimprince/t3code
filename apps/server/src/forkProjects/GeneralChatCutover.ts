import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** V2 writes a project baseline alongside its V1 creation, in the same cutover transaction. */
export const prepareGeneralChatV2Cutover = (sql: SqlClient.SqlClient) =>
  sql`DROP INDEX IF EXISTS idx_orch_events_unique_project_creation`;

/** Preserve one creation per history version, rather than forbidding the V2 baseline. */
export const finishGeneralChatV2Cutover = (sql: SqlClient.SqlClient) =>
  sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_events_unique_project_creation
    ON orchestration_events(stream_id, application_event_version)
    WHERE aggregate_kind = 'project' AND event_type = 'project.created'`;
