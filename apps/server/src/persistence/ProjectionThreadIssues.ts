import { normalizeThreadIssueKey } from "@t3tools/shared/threadIssues";
import {
  IsoDateTime,
  PositiveInt,
  ThreadId,
  ThreadIssueKey,
  ThreadIssueSnapshot,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const ProjectionThreadIssue = Schema.Struct({
  threadId: ThreadId,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  snapshot: ThreadIssueSnapshot,
});
export type ProjectionThreadIssue = typeof ProjectionThreadIssue.Type;

const ProjectionThreadIssueDbRow = ProjectionThreadIssue.mapFields(
  Struct.assign({ snapshot: Schema.fromJsonString(ThreadIssueSnapshot) }),
);

export class ProjectionThreadIssueRepository extends Context.Service<
  ProjectionThreadIssueRepository,
  {
    readonly upsert: (row: ProjectionThreadIssue) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly listByThreadId: (input: {
      threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<ProjectionThreadIssue>, ProjectionRepositoryError>;
    readonly delete: (
      input: { threadId: ThreadId } & ThreadIssueKey,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadId: (input: {
      threadId: ThreadId;
    }) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionThreadIssues/ProjectionThreadIssueRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadIssue,
    execute: (row) => sql`
      INSERT INTO projection_thread_issues
        (thread_id, host, repository, number, url, linked_at, snapshot_json)
      VALUES
        (${row.threadId}, ${row.host}, ${row.repository}, ${row.number}, ${row.url}, ${row.linkedAt}, ${JSON.stringify(row.snapshot)})
      ON CONFLICT (thread_id, host, repository, number) DO UPDATE SET
        url = excluded.url,
        linked_at = excluded.linked_at,
        snapshot_json = excluded.snapshot_json
    `,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ProjectionThreadIssueDbRow,
    execute: ({ threadId }) => sql`
      SELECT thread_id AS "threadId", host, repository, number, url,
             linked_at AS "linkedAt", snapshot_json AS "snapshot"
      FROM projection_thread_issues
      WHERE thread_id = ${threadId}
      ORDER BY linked_at ASC, number ASC
    `,
  });
  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId, ...ThreadIssueKey.fields }),
    execute: ({ threadId, host, repository, number }) => sql`
      DELETE FROM projection_thread_issues
      WHERE thread_id = ${threadId} AND host = ${host}
        AND repository = ${repository} AND number = ${number}
    `,
  });
  const deleteRows = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) =>
      sql`DELETE FROM projection_thread_issues WHERE thread_id = ${threadId}`,
  });

  return {
    upsert: (row) =>
      upsertRow({ ...row, ...normalizeThreadIssueKey(row) }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadIssueRepository.upsert:query")),
      ),
    listByThreadId: (input) =>
      listRows(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadIssueRepository.list:query")),
      ),
    delete: (input) =>
      deleteRow({ ...input, ...normalizeThreadIssueKey(input) }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadIssueRepository.delete:query")),
      ),
    deleteByThreadId: (input) =>
      deleteRows(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadIssueRepository.deleteAll:query")),
      ),
  } satisfies ProjectionThreadIssueRepository["Service"];
});

export const layer = Layer.effect(ProjectionThreadIssueRepository, make);
