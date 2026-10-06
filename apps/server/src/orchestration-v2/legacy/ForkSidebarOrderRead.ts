import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Read before migrations: a modern V1 null key means automatic ordering. */
export const needsLegacySidebarOrder = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    if (columns.length === 0) return false;
    if (!columns.some((column) => column.name === "active_order_key")) return true;
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_fork_migrations'`;
    if (tables.length === 0) return true;
    const migration =
      yield* sql`SELECT migration_id FROM effect_sql_fork_migrations WHERE migration_id = 5`;
    return migration.length === 0;
  });
