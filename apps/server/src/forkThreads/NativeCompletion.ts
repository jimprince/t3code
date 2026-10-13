import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  OrchestrationV2SubagentJson,
  type NativeCompletion,
  type ThreadId,
  type ForkThreadMetadata,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { completionAllowed } from "./WorkerLifecyclePolicy.ts";

const decodeTask = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2SubagentJson));

/** Read the latest exact child record, including running/failed successors. */
export const readNativeTask = (sql: SqlClient.SqlClient, child: ThreadId) =>
  sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_subagents WHERE child_thread_id=${child} AND origin='provider_native' ORDER BY updated_at DESC, subagent_id DESC LIMIT 1`.pipe(
    Effect.flatMap((rows) =>
      rows[0] ? decodeTask(rows[0].payload_json) : Effect.succeed(undefined),
    ),
  );
export const nativeEvidence = (task: OrchestrationV2Subagent): NativeCompletion | undefined =>
  task.startedAt == null
    ? undefined
    : {
        taskId: task.id,
        parentThreadId: task.threadId,
        startedAt: DateTime.formatIso(task.startedAt),
        updatedAt: DateTime.formatIso(task.updatedAt),
      };
export function nativeCompletionEligible(
  projection: OrchestrationV2ThreadProjection,
  task: OrchestrationV2Subagent | undefined,
  evidence: NativeCompletion,
  metadata?: ForkThreadMetadata,
  roots: ReadonlySet<ThreadId> = new Set(),
): boolean {
  const thread = projection.thread;
  return (
    completionAllowed(projection, metadata, roots) &&
    projection.runs.length === 0 &&
    !projection.providerThreads.some(
      (provider) =>
        provider.codexNativeGoal?.status === "active" ||
        backgroundWorkHoldsCompletion(provider.pendingBackgroundTasks ?? []),
    ) &&
    thread.creationSource === "provider" &&
    thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId === evidence.parentThreadId &&
    metadata?.parentThreadId === evidence.parentThreadId &&
    task?.origin === "provider_native" &&
    task.childThreadId === thread.id &&
    task.threadId === evidence.parentThreadId &&
    task.id === evidence.taskId &&
    task.status === "completed" &&
    task.completedAt != null &&
    task.startedAt != null &&
    DateTime.formatIso(task.startedAt) === evidence.startedAt &&
    DateTime.formatIso(task.updatedAt) === evidence.updatedAt &&
    !projection.nodes.some((node) =>
      ["running", "queued", "waiting", "starting"].includes(node.status),
    )
  );
}
