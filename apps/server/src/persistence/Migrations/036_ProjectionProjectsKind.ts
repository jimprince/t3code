import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds an explicit project kind while preserving historical workspace projects. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!columns.some((column) => column.name === "kind")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace'
    `;
  }
});
