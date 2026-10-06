import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { needsLegacySidebarOrder } from "../orchestration-v2/legacy/ForkSidebarOrderRead.ts";

/** Preserve source ordering semantics before setup appends newer migration identities. */
export const initializeSidebarOrderImport = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS fork_sidebar_order_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      needs_legacy_order INTEGER NOT NULL CHECK (needs_legacy_order IN (0, 1))
    )`;
    const recorded = yield* sql<{
      needs_legacy_order: number;
    }>`SELECT needs_legacy_order FROM fork_sidebar_order_import WHERE id = 1`;
    if (recorded[0] !== undefined) return recorded[0].needs_legacy_order === 1;
    const required = yield* needsLegacySidebarOrder(sql);
    yield* sql`INSERT OR IGNORE INTO fork_sidebar_order_import VALUES (1, ${required ? 1 : 0})`;
    const saved = yield* sql<{
      needs_legacy_order: number;
    }>`SELECT needs_legacy_order FROM fork_sidebar_order_import WHERE id = 1`;
    return saved[0]?.needs_legacy_order === 1;
  });
