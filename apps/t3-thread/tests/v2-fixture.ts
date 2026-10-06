import { OrchestrationV2ThreadProjection, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { Schema } from "effect";

const decodeProjection = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadProjection),
);
const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);

export const at = (minutes = 0) =>
  new Date(Date.parse("2026-10-05T00:00:00Z") + minutes * 60_000).toISOString();
export function projection(overrides: Record<string, unknown> = {}) {
  return decodeProjection({
    thread: {
      id: "worker",
      projectId: "project",
      title: "Worker",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: "parent",
        relationshipToParent: "subagent",
        rootThreadId: "parent",
      },
      forkedFrom: null,
      createdAt: at(),
      updatedAt: at(),
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [
      {
        id: "run",
        threadId: "worker",
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        providerThreadId: null,
        userMessageId: "prompt",
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: at(),
        startedAt: at(),
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: at(),
    ...overrides,
  });
}
export const request = (id: string, status = "pending", kind = "user_input") => ({
  id,
  nodeId: "node",
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status,
  responseCapability: { type: "message" },
  createdAt: at(),
  resolvedAt: null,
});
export const item = (
  type = "reasoning",
  updatedAt = at(),
  fields: Record<string, unknown> = {},
) => ({
  id: "item",
  threadId: "worker",
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: at(),
  completedAt: null,
  updatedAt,
  type,
  text: "Thinking",
  streaming: true,
  ...fields,
});

/** Native V2 shell, including required execution and settlement fields. */
export function shell(overrides: Record<string, unknown> = {}) {
  return decodeShell({
    ...projection().thread,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    ...overrides,
  });
}
export function shellSnapshot(threads: ReturnType<typeof shell>[]) {
  return {
    kind: "snapshot" as const,
    snapshot: {
      schemaVersion: 2,
      snapshotSequence: 1,
      projects: [],
      threads,
      archivedThreads: [],
    },
  };
}
