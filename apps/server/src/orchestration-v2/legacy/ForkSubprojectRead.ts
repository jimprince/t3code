import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
/** Retain V1 explicit subproject modes without writing the retired projection. */
export const readForkSubprojects = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    if (!columns.some((c) => c.name === "subproject")) return [];
    return yield* sql<{
      thread_id: string;
      subproject: "auto" | "on" | "off" | null;
    }>`SELECT thread_id, subproject FROM projection_threads`;
  });
