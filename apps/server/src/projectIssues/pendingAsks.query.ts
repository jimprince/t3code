import {
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2TurnItemJson,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Most pending requests read for one thread; a thread rarely has more than one. */
const MAX_PENDING_REQUESTS = 5;
/**
 * Newest turn items of a request's node that are looked at to find its question or
 * approval text. The request blocks its run, so its item is among the last ones.
 */
export const REQUEST_ITEM_WINDOW = 200;

/** The thread's pending requests: its (thread_id, status) index, newest first, capped. */
export const PENDING_REQUESTS_SQL = `
  SELECT payload_json FROM orchestration_v2_projection_runtime_requests
    INDEXED BY orchestration_v2_projection_runtime_requests_thread_status_idx
  WHERE thread_id = ? AND status = 'pending'
  ORDER BY created_at DESC, runtime_request_id DESC
  LIMIT ${MAX_PENDING_REQUESTS}`;

/** A node's newest items by its (node_id, ordinal) index, then the request-carrying ones. */
export const REQUEST_ITEMS_SQL = `
  SELECT payload_json FROM (
    SELECT type, payload_json FROM orchestration_v2_projection_turn_items
      INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
    WHERE node_id = ?
    ORDER BY ordinal DESC
    LIMIT ${REQUEST_ITEM_WINDOW}
  ) WHERE type IN ('user_input_request', 'approval_request')`;

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
);
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

interface PayloadRow {
  readonly payload_json: string;
}

/**
 * The pending requests of one thread with the turn items that carry their text,
 * shaped like the two arrays `derivePendingThreadRequests` reads. The work is bounded
 * by the caps above, whatever the length of the thread's history: nothing else of the
 * thread is hydrated.
 */
export const readPendingRequests = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const requestRows = yield* sql.unsafe<PayloadRow>(PENDING_REQUESTS_SQL, [threadId]);
    const runtimeRequests = yield* Effect.forEach(requestRows, (row) =>
      decodeRequest(row.payload_json),
    );
    const nodeIds = [...new Set(runtimeRequests.map((request) => request.nodeId))];
    const itemRows = yield* Effect.forEach(nodeIds, (nodeId) =>
      sql.unsafe<PayloadRow>(REQUEST_ITEMS_SQL, [nodeId]),
    );
    const turnItems = yield* Effect.forEach(itemRows.flat(), (row) => decodeItem(row.payload_json));
    return { runtimeRequests, turnItems };
  });
