import { NamedAgentError, type ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

// Shared by project naming, root creation and organizational unnesting on one database.
const locks = new WeakMap<SqlClient.SqlClient, Semaphore.Semaphore>();
export const withOwnershipLock = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    let lock = locks.get(sql);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(sql, lock);
    }
    return lock.withPermits(1)(effect);
  });

export const namedAgentName = (sql: SqlClient.SqlClient, projectId: ProjectId) =>
  sql<{
    name: string | null;
  }>`SELECT json_extract(permanent_agent_json, '$.name') AS name FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`.pipe(
    Effect.map((rows) => rows[0]?.name ?? null),
  );

export const liveRoots = (sql: SqlClient.SqlClient, projectId: ProjectId, except?: ThreadId) =>
  sql<{ thread_id: string; payload_json: string }>`SELECT t.thread_id,t.payload_json
    FROM orchestration_v2_projection_threads t
    LEFT JOIN fork_thread_metadata m ON m.thread_id=t.thread_id
    WHERE json_extract(t.payload_json,'$.projectId')=${projectId}
      AND json_extract(t.payload_json,'$.archivedAt') IS NULL
      AND json_extract(t.payload_json,'$.deletedAt') IS NULL
      AND json_extract(t.payload_json,'$.lineage.parentThreadId') IS NULL
      AND (json_extract(t.payload_json,'$.autoSettleDisabledAt') IS NOT NULL
        OR json_extract(t.payload_json,'$.historyOrigin')='v1_import'
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id))
      AND json_extract(m.payload,'$.parentThreadId') IS NULL
      AND json_extract(m.payload,'$.remoteParent') IS NULL
      AND (${except ?? null} IS NULL OR t.thread_id<>${except ?? null})`;

export const assertRootSlot = (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const name = yield* namedAgentName(sql, projectId);
    if (name === null) return null;
    const roots = yield* liveRoots(sql, projectId, threadId);
    if (roots.length > 0)
      return yield* new NamedAgentError({
        message: `Named agent '${name}' already has a live thread (${roots[0]!.thread_id}). Send to it, or hand it over.`,
      });
    return name;
  });

export const validateNaming = (sql: SqlClient.SqlClient, projectId: ProjectId, name: string) =>
  Effect.gen(function* () {
    const namesakes = yield* sql<{
      project_id: string;
    }>`SELECT project_id FROM projection_projects WHERE deleted_at IS NULL AND project_id<>${projectId} AND json_extract(permanent_agent_json,'$.name')=${name}`;
    if (namesakes.length > 0)
      return yield* new NamedAgentError({
        message: `Named agent '${name}' already exists in project '${namesakes[0]!.project_id}'.`,
      });
    if ((yield* liveRoots(sql, projectId)).length > 1)
      return yield* new NamedAgentError({
        message: `Project '${projectId}' has several live top-level threads; archive or nest all but one before naming it an agent.`,
      });
  });

/** Empty claims become roots only when their first input is admitted. */
export const isOrganizationalRoot = (
  sql: SqlClient.SqlClient,
  thread: { readonly id: ThreadId; readonly lineage: { readonly parentThreadId: ThreadId | null } },
) =>
  Effect.gen(function* () {
    if (thread.lineage.parentThreadId !== null) return false;
    const rows = yield* sql<{
      parent: string | null;
      remote: string | null;
    }>`SELECT json_extract(payload,'$.parentThreadId') AS parent,json_extract(payload,'$.remoteParent') AS remote FROM fork_thread_metadata WHERE thread_id=${thread.id}`;
    return rows[0]?.parent == null && rows[0]?.remote == null;
  });
