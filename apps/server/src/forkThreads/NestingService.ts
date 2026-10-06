import {
  CommandId,
  type OrchestrationV2ServerCommand,
  ForkThreadMetadataError,
  ForkThreadMetadata,
  type ForkThreadMetadataUpdate,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { initializeMetadata, listMetadata, writeMetadata, metadataJson } from "./MetadataStore.ts";

type NestingShell = Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "archivedAt">;
/** Commit supervision metadata before publishing a replay-safe native shell refresh. */
export const makeNestingService = <E, R, DispatchError = never, DispatchContext = never>(
  sql: SqlClient.SqlClient,
  getShell: (id: ThreadId) => Effect.Effect<NestingShell | null, E, R>,
  refreshShell: (
    command: Extract<OrchestrationV2ServerCommand, { type: "thread.metadata.update" }>,
  ) => Effect.Effect<unknown, DispatchError, DispatchContext>,
) =>
  Effect.gen(function* () {
    yield* initializeMetadata(sql);
    const list = () => listMetadata(sql);
    const update = (input: ForkThreadMetadataUpdate) =>
      sql
        .withTransaction(
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
              ...(input.settleOnComplete !== undefined
                ? { settleOnComplete: input.settleOnComplete }
                : {}),
              parentThreadId,
              remoteParent,
              ...(input.scope !== undefined ? { scope: input.scope?.trim() || null } : {}),
            };
            yield* writeMetadata(sql, value);
            const payload = yield* Schema.encodeEffect(metadataJson)(value);
            yield* sql`INSERT INTO fork_thread_metadata_receipts (command_id, payload) VALUES (${input.commandId}, ${payload})`;
            return value;
          }),
        )
        .pipe(
          Effect.tap(() =>
            refreshShell({
              type: "thread.metadata.update",
              commandId: CommandId.make(`${input.commandId}:shell-refresh`),
              threadId: input.threadId,
            }),
          ),
        );
    return { list, update };
  });
