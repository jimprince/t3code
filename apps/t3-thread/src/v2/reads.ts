import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
  latestRootProviderFailure,
  threadErrorSummary,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { DateTime } from "effect";
import type {
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { OrchestrationThread, OrchestrationThreadShell } from "../types.js";

const iso = (date: DateTime.Utc) => DateTime.formatIso(date);
const nullableIso = (date: DateTime.Utc | null | undefined) => (date == null ? null : iso(date));
export function modelSelection(selection: ModelSelection) {
  return {
    provider: selection.instanceId,
    model: selection.model,
    ...(selection.options
      ? { options: Object.fromEntries(selection.options.map(({ id, value }) => [id, value])) }
      : {}),
  };
}
export function projectShell(project: OrchestrationProjectShell) {
  return {
    ...project,
    defaultModelSelection: project.defaultModelSelection
      ? modelSelection(project.defaultModelSelection)
      : null,
  };
}
function latestRun(
  id: string | null,
  status: string,
  requestedAt: string,
  startedAt: string | null,
  completedAt: string | null,
) {
  if (!id) return null;
  return {
    turnId: id,
    state:
      status === "failed"
        ? ("error" as const)
        : status === "completed"
          ? ("completed" as const)
          : ["interrupted", "cancelled", "rolled_back"].includes(status)
            ? ("interrupted" as const)
            : ("running" as const),
    requestedAt,
    startedAt,
    completedAt,
    assistantMessageId: null,
  };
}
export function threadShell(thread: OrchestrationV2ThreadShell): OrchestrationThreadShell {
  return {
    ...thread,
    latestRunStartedAt: nullableIso(thread.latestRunStartedAt),
    modelSelection: modelSelection(thread.modelSelection),
    parentThreadId: null,
    executionParentThreadId: thread.lineage.parentThreadId,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
    archivedAt: nullableIso(thread.archivedAt),
    settledAt: nullableIso(thread.settledAt),
    unsettledAt: nullableIso(thread.unsettledAt),
    pinnedAt: nullableIso(thread.pinnedAt),
    latestTurn: latestRun(
      thread.latestRunId,
      thread.status,
      nullableIso(thread.latestRunRequestedAt) ?? iso(thread.createdAt),
      nullableIso(thread.latestRunStartedAt),
      nullableIso(thread.latestRunCompletedAt),
    ),
    session: null,
    latestUserMessageAt: nullableIso(thread.latestUserMessageAt),
    hasPendingApprovals:
      thread.pendingRuntimeRequest != null && thread.pendingRuntimeRequest.kind !== "user_input",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
  };
}
export function threadDetail(projection: OrchestrationV2ThreadProjection): OrchestrationThread {
  const thread = projection.thread;
  const providerSession = projection.providerSessions
    .filter((session) => session.providerInstanceId === thread.providerInstanceId)
    .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))[0];
  const run =
    usageLimitRunPresentedAsLatest(
      projection.runs,
      projection.turnItems,
      providerSession?.lastError ?? null,
    ) ?? latestUnheldRun(projection.runs);
  const pending = projection.runtimeRequests.filter((request) => request.status === "pending");
  return {
    ...thread,
    modelSelection: modelSelection(thread.modelSelection),
    parentThreadId: null,
    executionParentThreadId: thread.lineage.parentThreadId,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
    archivedAt: nullableIso(thread.archivedAt),
    deletedAt: nullableIso(thread.deletedAt),
    settledAt: nullableIso(thread.settledAt),
    unsettledAt: nullableIso(thread.unsettledAt),
    pinnedAt: nullableIso(thread.pinnedAt),
    latestTurn: latestRun(
      run?.id ?? null,
      run?.status ?? "idle",
      nullableIso(run?.requestedAt) ?? iso(thread.createdAt),
      nullableIso(run?.startedAt),
      nullableIso(run?.completedAt),
    ),
    ...threadErrorSummary(
      latestRootProviderFailure(run ?? null, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    session: null, // V2 provider sessions are runtime resources, never V1 session summaries.
    messages: projection.messages.map((message) => ({
      ...message,
      turnId: message.runId,
      createdAt: iso(message.createdAt),
      updatedAt: iso(message.updatedAt),
    })),
    proposedPlans: projection.plans.flatMap((plan) =>
      plan.kind === "proposed_plan"
        ? [
            {
              id: plan.id,
              turnId: plan.runId,
              planMarkdown: plan.markdown,
              implementedAt:
                plan.status === "completed" || plan.status === "superseded"
                  ? iso(projection.updatedAt)
                  : null,
              createdAt: iso(projection.updatedAt),
              updatedAt: iso(projection.updatedAt),
            },
          ]
        : [],
    ),
    runtimeRequests: pending,
    activities: [],
    checkpoints: [],
    projection,
  };
}
