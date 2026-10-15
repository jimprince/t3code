import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Virtual names share standing-agent resolution, without changing singleton projects. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE named_virtual_agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
    version INTEGER NOT NULL, payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE named_virtual_agent_revisions (
    agent_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (agent_id, version)
  )`;
});
