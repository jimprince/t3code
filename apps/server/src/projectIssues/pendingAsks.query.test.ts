import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { pendingAsksOfThread } from "./decisionFeed.logic.ts";
import {
  PENDING_REQUESTS_SQL,
  REQUEST_ITEMS_SQL,
  REQUEST_ITEM_WINDOW,
  readPendingRequests,
} from "./pendingAsks.query.ts";
import { AT, NODE, insertQuestion, insertRequest } from "./pendingAsks.testkit.ts";

const THREAD = ThreadId.make("thread-1");

/** `count` unrelated items: in the request's node (before it) or in other nodes. */
const insertHistory = (sql: SqlClient.SqlClient, count: number, nodeId: string, first: number) =>
  sql.unsafe(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO orchestration_v2_projection_turn_items
       (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json)
     SELECT ? || '-' || i, ?, NULL, ?, NULL, NULL, NULL, ? + i, 'system_notice', 'completed', ?, '{}'
     FROM n`,
    [count - 1, `history-${nodeId}-${first}`, THREAD, nodeId, first, AT],
  );

describe("reading a thread's pending requests", () => {
  it.effect("returns the question text of a pending request and skips a resolved one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRequest(sql, {
        id: "r-old",
        thread: THREAD,
        status: "resolved",
        at: "2026-10-07T00:00:00.000Z",
      });
      yield* insertRequest(sql, { id: "r-now", thread: THREAD, status: "pending", at: AT });
      yield* insertQuestion(sql, THREAD, "r-now", 5);

      const asks = pendingAsksOfThread(
        { id: THREAD, title: "Printer Voice", projectTitle: "Home Assistant" },
        yield* readPendingRequests(sql, THREAD),
      );
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({
        kind: "question",
        requestId: "r-now",
        threadTitle: "Printer Voice",
        projectTitle: "Home Assistant",
      });
      const question = asks[0];
      expect(question?.kind === "question" && question.questions[0]?.question).toBe(
        "Did the timer stop, and did you then hear the reminder?",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("reads the same rows however long the thread's history is", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRequest(sql, { id: "r-now", thread: THREAD, status: "pending", at: AT });
      // A short history before the question, so the answer can be compared with a long one.
      yield* insertHistory(sql, 20, NODE, 0);
      yield* insertQuestion(sql, THREAD, "r-now", 20);
      const short = yield* readPendingRequests(sql, THREAD);

      // Thousands of earlier items in the same node, and in other nodes of the thread.
      yield* insertHistory(sql, 3000, "node-other", 100);
      yield* insertHistory(sql, 3000, NODE, 100_000);
      yield* sql.unsafe(
        `UPDATE orchestration_v2_projection_turn_items SET ordinal = ordinal + 200000 WHERE turn_item_id = 'item-r-now'`,
      );
      const long = yield* readPendingRequests(sql, THREAD);

      expect(long.runtimeRequests).toEqual(short.runtimeRequests);
      expect(long.turnItems.map((item) => item.id)).toEqual(short.turnItems.map((item) => item.id));
      expect(long.turnItems).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "stays on the indexes and inside the window, so the work does not grow with history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = (statement: string) =>
          sql
            .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`, ["x"])
            .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

        const requests = yield* plan(PENDING_REQUESTS_SQL);
        expect(requests).toMatch(
          /SEARCH orchestration_v2_projection_runtime_requests USING INDEX orchestration_v2_projection_runtime_requests_thread_status_idx \(thread_id=\? AND status=\?\)/,
        );

        const items = yield* plan(REQUEST_ITEMS_SQL);
        expect(items).toMatch(
          /SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_node_ordinal_idx \(node_id=\?\)/,
        );
        expect(items).not.toMatch(/SCAN orchestration_v2_projection_turn_items/);
        // Newest-first by the index itself: no sort of the node's whole history.
        expect(items).not.toMatch(/TEMP B-TREE/);
        expect(REQUEST_ITEMS_SQL).toContain(`LIMIT ${REQUEST_ITEM_WINDOW}`);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("leaves a request out rather than reading further back for its text", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRequest(sql, { id: "r-now", thread: THREAD, status: "pending", at: AT });
      yield* insertQuestion(sql, THREAD, "r-now", 0);
      yield* insertHistory(sql, REQUEST_ITEM_WINDOW + 50, NODE, 10);

      const read = yield* readPendingRequests(sql, THREAD);
      expect(read.runtimeRequests).toHaveLength(1);
      expect(read.turnItems).toEqual([]);
      expect(pendingAsksOfThread({ id: THREAD, title: "t", projectTitle: "p" }, read)).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
