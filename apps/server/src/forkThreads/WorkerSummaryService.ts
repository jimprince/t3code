import type { ThreadId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** A bounded first nonblank line; scanning stops as soon as the preview is full. */
function workerOutput(text: string | null): string | null {
  if (text === null) return null;
  const start = /\S/u.exec(text)?.index;
  if (start === undefined) return null;
  let result = "";
  for (let i = start; i < text.length && result.length < 320; i++) {
    const ch = text[i]!;
    if (ch === "\n" || ch === "\r") break;
    result += ch;
  }
  return result.trimEnd() || null;
}

/** Only organizational children get transcript/usage queries, never ordinary roots. */
export const readWorkerSummaries = (sql: SqlClient.SqlClient, threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    if (threadIds.length === 0) return new Map();
    const rows = yield* sql<{
      thread_id: string;
      output: string | null;
      message_count: number;
      tool_count: number;
      used_tokens: number | null;
      activity: string | null;
    }>`
    SELECT t.thread_id,
      (SELECT substr(json_extract(m.payload_json, '$.text'),1,4096) FROM orchestration_v2_projection_messages m WHERE m.thread_id=t.thread_id AND m.role='assistant' ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1) AS output,
      (SELECT count(*) FROM orchestration_v2_projection_messages m WHERE m.thread_id=t.thread_id) AS message_count,
      (SELECT count(*) FROM orchestration_v2_projection_turn_items i WHERE i.thread_id=t.thread_id AND i.type IN ('command_execution','file_change','dynamic_tool','mcp_tool_call','web_search')) AS tool_count,
      (SELECT json_extract(p.payload_json,'$.tokenUsage.usedTokens') FROM orchestration_v2_projection_provider_turns p WHERE p.thread_id=t.thread_id ORDER BY p.ordinal DESC LIMIT 1) AS used_tokens,
      (SELECT i.type FROM orchestration_v2_projection_turn_items i WHERE i.thread_id=t.thread_id ORDER BY i.ordinal DESC LIMIT 1) AS activity
    FROM orchestration_v2_projection_threads t WHERE ${sql.in("t.thread_id", threadIds)}
  `;
    return new Map(
      rows.map((row) => [
        row.thread_id,
        {
          output: workerOutput(row.output),
          messageCount: row.message_count,
          toolCount: row.tool_count,
          usedTokens: row.used_tokens,
          activity: row.activity,
          history: "v2" as const,
        },
      ]),
    );
  });

/** One transport seam covers initial, live and archived shell reads. */
export const withWorkerSummaries = Effect.fn("WorkerSummary.withShellReads")(function* (
  service: typeof ThreadManagement.ThreadManagementService,
) {
  const native = yield* service;
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table' AND name='fork_thread_metadata'`.pipe(
    Effect.orDie,
  );
  const enrich = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    Effect.gen(function* () {
      if (tables.length === 0 || shells.length === 0) return shells;
      const metadata = yield* sql<{
        thread_id: string;
        payload: string;
      }>`SELECT thread_id,payload FROM fork_thread_metadata WHERE ${sql.in(
        "thread_id",
        shells.map((s) => s.id),
      )}`;
      const parents = new Map(
        metadata.map((row) => [
          row.thread_id,
          JSON.parse(row.payload) as {
            parentThreadId?: ThreadId | null;
            remoteParent?: { environmentId: string; threadId: ThreadId } | null;
          },
        ]),
      );
      const summaries = yield* readWorkerSummaries(
        sql,
        metadata
          .filter(
            (r) =>
              parents.get(r.thread_id)?.parentThreadId != null ||
              parents.get(r.thread_id)?.remoteParent != null,
          )
          .map((r) => r.thread_id as ThreadId),
      );
      return shells.map((shell) => {
        const summary = summaries.get(shell.id);
        return summary === undefined
          ? shell
          : {
              ...shell,
              workerSummary: {
                ...summary,
                history:
                  shell.historyOrigin === "v1_import"
                    ? ("legacy-unavailable" as const)
                    : ("v2" as const),
              },
            };
      });
    });
  return {
    ...native,
    getShellSnapshot: (...args: Parameters<typeof native.getShellSnapshot>) =>
      native.getShellSnapshot(...args).pipe(
        Effect.flatMap((snapshot) =>
          enrich([...snapshot.threads, ...snapshot.archivedThreads]).pipe(
            Effect.orDie,
            Effect.map((shells) => ({
              ...snapshot,
              threads: shells.filter((s) => s.archivedAt === null),
              archivedThreads: shells.filter((s) => s.archivedAt !== null),
            })),
          ),
        ),
      ),
    getThreadShells: (ids: ReadonlyArray<ThreadId>) =>
      native.getThreadShells(ids).pipe(
        Effect.flatMap((shells) =>
          enrich(shells.filter((shell) => shell !== null)).pipe(
            Effect.orDie,
            Effect.map((enriched) => {
              const byId = new Map(enriched.map((shell) => [shell.id, shell]));
              return shells.map((shell) => (shell === null ? null : byId.get(shell.id)!));
            }),
          ),
        ),
      ),
    getThreadShell: (id: ThreadId) =>
      native.getThreadShell(id).pipe(
        Effect.flatMap((shell) =>
          shell === null
            ? Effect.succeed(null)
            : enrich([shell]).pipe(
                Effect.orDie,
                Effect.map((shells) => shells[0]!),
              ),
        ),
      ),
  };
});
