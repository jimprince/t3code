import { assertRootSlot, withOwnershipLock } from "./NamedAgentPolicy.ts";
import {
  CommandId,
  ForkThreadMetadataError,
  ForkThreadMetadata,
  type ForkThreadMetadataUpdate,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { listMetadata, writeMetadata, metadataJson } from "./MetadataStore.ts";

/**
 * Inert until all clients can navigate promoted subprojects: mobile cannot yet reach a
 * subproject's decisions. An explicit mark still works; tests turn promotion on through
 * `autoPromoteSubprojects`.
 */
const AUTO_PROMOTE_SUBPROJECTS = false;

type NestingShell = Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "archivedAt">;
/** Commit supervision metadata, then publish a native shell refresh with replay-safe receipts. */
export const makeNestingService = <E, R, DispatchError, DispatchContext>(
  sql: SqlClient.SqlClient,
  getShell: (id: ThreadId) => Effect.Effect<NestingShell | null, E, R>,
  dispatch: (command: {
    type: "thread.metadata.update";
    commandId: CommandId;
    threadId: ThreadId;
    bumpForkMetadataRevision: true;
  }) => Effect.Effect<unknown, DispatchError, DispatchContext>,
  options: { readonly autoPromoteSubprojects?: boolean } = {},
) =>
  Effect.gen(function* () {
    const autoPromote = options.autoPromoteSubprojects ?? AUTO_PROMOTE_SUBPROJECTS;
    const list = () => listMetadata(sql);
    const persist = (input: ForkThreadMetadataUpdate) =>
      withOwnershipLock(
        sql,
        sql.withTransaction(
          Effect.gen(function* () {
            const receipts = yield* sql<{
              payload: string;
            }>`SELECT payload FROM fork_thread_metadata_receipts WHERE command_id = ${input.commandId}`;
            if (receipts[0])
              return yield* Schema.decodeUnknownEffect(metadataJson)(receipts[0].payload);
            const child = yield* getShell(input.threadId);
            if (!child || child.archivedAt !== null)
              return yield* new ForkThreadMetadataError({
                message: "Child thread is missing or archived.",
              });
            const rows = yield* list();
            const existing = rows.find((row) => row.threadId === input.threadId) ?? {
              threadId: input.threadId,
              parentThreadId: null,
            };
            const parentThreadId =
              input.parentThreadId === undefined ? existing.parentThreadId : input.parentThreadId;
            const remoteParent =
              input.remoteParent === undefined
                ? (existing.remoteParent ?? null)
                : input.remoteParent;
            if (parentThreadId !== null && remoteParent !== null)
              return yield* new ForkThreadMetadataError({
                message: "Local and remote parents cannot coexist.",
              });
            if (parentThreadId !== null && input.parentThreadId !== undefined) {
              const parent = yield* getShell(parentThreadId);
              if (!parent || parent.archivedAt !== null)
                return yield* new ForkThreadMetadataError({
                  message: "Parent thread is missing or archived.",
                });
              const parents = new Map(rows.map((row) => [row.threadId, row.parentThreadId]));
              const seen = new Set<ThreadId>([input.threadId]);
              let cursor: ThreadId | null = parentThreadId;
              while (cursor !== null) {
                if (seen.has(cursor))
                  return yield* new ForkThreadMetadataError({
                    message: "Supervision cannot contain a cycle.",
                  });
                seen.add(cursor);
                cursor = parents.get(cursor) ?? null;
              }
            }
            const value: ForkThreadMetadata = {
              ...existing,
              ...(input.subproject !== undefined ? { subproject: input.subproject } : {}),
              ...(input.settleOnComplete !== undefined
                ? { settleOnComplete: input.settleOnComplete }
                : {}),
              parentThreadId,
              remoteParent,
              ...(input.scope !== undefined ? { scope: input.scope?.trim() || null } : {}),
            };
            if (parentThreadId === null && remoteParent === null) {
              const tables = yield* sql<{
                name: string;
              }>`SELECT name FROM sqlite_master WHERE name='orchestration_v2_projection_threads'`;
              if (tables.length > 0)
                yield* assertRootSlot(sql, child.projectId, input.threadId).pipe(
                  Effect.mapError(
                    (cause) => new ForkThreadMetadataError({ message: String(cause) }),
                  ),
                );
            }
            yield* writeMetadata(sql, value);
            if (autoPromote && input.parentThreadId) {
              const parent = rows.find((row) => row.threadId === input.parentThreadId);
              if (parent?.parentThreadId && (parent.subproject ?? "auto") === "auto")
                yield* writeMetadata(sql, { ...parent, subproject: "on" });
            }
            const payload = yield* Schema.encodeEffect(metadataJson)(value);
            yield* sql`INSERT INTO fork_thread_metadata_receipts (command_id, payload) VALUES (${input.commandId}, ${payload})`;
            return value;
          }),
        ),
      );
    const update = (input: ForkThreadMetadataUpdate) =>
      Effect.gen(function* () {
        const before =
          input.subproject === undefined
            ? undefined
            : (yield* list()).find((row) => row.threadId === input.threadId);
        const value = yield* persist(input);
        if (
          input.subproject !== undefined &&
          (before?.subproject ?? "auto") === (value.subproject ?? "auto") &&
          input.parentThreadId === undefined &&
          input.remoteParent === undefined &&
          input.scope === undefined &&
          input.settleOnComplete === undefined
        )
          return value;
        // Dispatch outside the SQL transaction. Retry also repairs an interrupted refresh.
        yield* dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${input.commandId}:shell-refresh`),
          threadId: input.threadId,
          bumpForkMetadataRevision: true,
        });
        return value;
      });
    return { list, update };
  });
