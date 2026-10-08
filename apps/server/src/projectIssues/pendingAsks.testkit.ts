import {
  NodeId,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2TurnItemJson,
  ProviderSessionId,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/** Rows for tests of the pending-ask read: a pending request and the item with its question. */
export const NODE = NodeId.make("node-1");
export const AT = "2026-10-08T01:00:00.000Z";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2RuntimeRequestJson));
const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItemJson));

export const insertRequest = (
  sql: SqlClient.SqlClient,
  input: { id: string; thread: ThreadId; status: "pending" | "resolved"; at: string },
) =>
  sql.unsafe(
    `INSERT INTO orchestration_v2_projection_runtime_requests
       (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, resolved_at, payload_json)
     VALUES (?, ?, ?, NULL, 'user_input', ?, ?, NULL, ?)`,
    [
      input.id,
      input.thread,
      NODE,
      input.status,
      input.at,
      encodeRequest({
        id: RuntimeRequestId.make(input.id),
        nodeId: NODE,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: input.status,
        responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("s1") },
        createdAt: DateTime.makeUnsafe(input.at),
        resolvedAt: null,
      }),
    ],
  );

export const insertQuestion = (
  sql: SqlClient.SqlClient,
  thread: ThreadId,
  requestId: string,
  ordinal: number,
) =>
  sql.unsafe(
    `INSERT INTO orchestration_v2_projection_turn_items
       (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json)
     VALUES (?, ?, NULL, ?, NULL, NULL, NULL, ?, 'user_input_request', 'pending', ?, ?)`,
    [
      `item-${requestId}`,
      thread,
      NODE,
      ordinal,
      AT,
      encodeItem({
        type: "user_input_request",
        id: TurnItemId.make(`item-${requestId}`),
        threadId: thread,
        runId: null,
        nodeId: NODE,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "pending",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(AT),
        requestId: RuntimeRequestId.make(requestId),
        questions: [
          {
            id: "heard",
            header: "Timer",
            question: "Did the timer stop, and did you then hear the reminder?",
            options: [{ label: "Yes", description: "Stopped and heard" }],
          },
        ],
      }),
    ],
  );
