import { isPermanentRoot } from "./PermanentRoots.ts";
import type {
  ForkThreadMetadata,
  ThreadId,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/** Called again inside native automatic settlement after its snapshot race guard. */
export function completionAllowed(
  projection: OrchestrationV2ThreadProjection,
  metadata?: ForkThreadMetadata,
  permanentRoots: ReadonlySet<ThreadId> = new Set(),
): boolean {
  const thread = projection.thread;
  return (
    thread.archivedAt == null &&
    thread.deletedAt == null &&
    thread.settledOverride == null &&
    thread.autoSettleDisabledAt == null &&
    thread.pinnedAt == null &&
    !isPermanentRoot(thread.id, permanentRoots) &&
    metadata?.settleOnComplete !== false &&
    (metadata?.virtualAgentId === undefined || metadata.virtualResultCapturedAt !== undefined) &&
    !projection.runs.some((run) =>
      ["queued", "running", "waiting", "starting"].includes(run.status),
    ) &&
    !projection.runtimeRequests.some((request) => request.status === "pending") &&
    !projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && ["draft", "active"].includes(plan.status),
    )
  );
}

export function completionEligible(
  projection: OrchestrationV2ThreadProjection,
  runId: string,
  metadata?: ForkThreadMetadata,
  permanentRoots: ReadonlySet<ThreadId> = new Set(),
): boolean {
  const latest = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, run) => (latest == null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  return (
    completionAllowed(projection, metadata, permanentRoots) &&
    latest?.id === runId &&
    latest.status === "completed"
  );
}
