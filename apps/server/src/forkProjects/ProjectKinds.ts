import { GeneralChatInvariantError } from "./GeneralChatError.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Import shipped kind metadata once; V2 owns the project row and its history. */
export const initializeProjectKinds = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS fork_project_kinds (
    project_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('workspace', 'chat'))
  )`;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
    if (columns.some((column) => column.name === "kind")) {
      yield* sql`INSERT OR IGNORE INTO fork_project_kinds (project_id, kind)
      SELECT project_id, kind FROM projection_projects WHERE kind IN ('workspace', 'chat')`;
    }
  });

export const writeProjectKind = (sql: SqlClient.SqlClient, projectId: string, kind: string) =>
  sql`INSERT OR IGNORE INTO fork_project_kinds (project_id, kind) VALUES (${projectId}, ${kind})`;

/** Chat metadata remains server-owned, as in the shipped project decider. */
export const validateChatMutation = (
  project: {
    readonly kind?: string | undefined;
    readonly title: string;
    readonly workspaceRoot: string;
  },
  input: object,
) =>
  Effect.gen(function* () {
    if (project.kind !== "chat") return;
    const forbidden =
      "delete" in input ||
      ("title" in input && input.title !== undefined) ||
      ("workspaceRoot" in input && input.workspaceRoot !== undefined) ||
      ("scripts" in input && input.scripts !== undefined) ||
      ("defaultModelSelection" in input && input.defaultModelSelection !== undefined) ||
      ("autoPull" in input && input.autoPull === true);
    if (forbidden)
      return yield* new GeneralChatInvariantError({
        message: "General Chat's identity and workspace are server-owned.",
      });
  });
