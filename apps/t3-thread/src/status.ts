import type { AgentStatus, OrchestrationThread, OrchestrationThreadShell } from "./types.js";

/**
 * The source turn a new subscription should treat as already known.
 *
 * A source that is idle, completed, or errored at subscribe time has nothing
 * new to say about that turn, so it becomes the baseline and is never routed.
 * A source that is mid-turn returns null: the subscriber signed up to hear
 * how that turn ends, so its completion must still route.
 */
export function subscriptionBaselineTurnId(thread: OrchestrationThread): string | null {
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  if (!latestTurnId || classifyThread(thread).state === "running") {
    return null;
  }
  return latestTurnId;
}

export function classifyThread(
  thread: OrchestrationThread | OrchestrationThreadShell,
): AgentStatus {
  if (thread.archivedAt) {
    return {
      state: "archived",
      reason: "thread is archived",
    };
  }

  const hasActionableProposedPlan =
    thread.hasActionableProposedPlan !== undefined
      ? thread.hasActionableProposedPlan
      : ("proposedPlans" in thread ? thread.proposedPlans : []).some((plan) => !plan.implementedAt);
  if (hasActionableProposedPlan) {
    return {
      state: "needs-plan",
      reason: "plan is ready for action",
    };
  }

  const pending =
    "runtimeRequests" in thread
      ? (thread.runtimeRequests ?? []).filter((request) => request.status === "pending")
      : [];
  if (
    ("hasPendingApprovals" in thread && thread.hasPendingApprovals) ||
    pending.some((request) => request.kind !== "user_input")
  ) {
    return {
      state: "needs-approval",
      reason: "approval request is pending",
    };
  }

  if (
    ("hasPendingUserInput" in thread && thread.hasPendingUserInput) ||
    pending.some((request) => request.kind === "user_input")
  ) {
    return {
      state: "needs-input",
      reason: "user input is pending",
    };
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      state: "error",
      reason: thread.lastError || thread.session?.lastError || "turn failed",
    };
  }

  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    (thread.session?.activeTurnId ?? null) !== null
  ) {
    return {
      state: "running",
      reason: "turn is running",
    };
  }

  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted") {
    return {
      state: "interrupted",
      reason: "turn was interrupted",
    };
  }

  if (thread.latestTurn?.state === "completed") {
    return {
      state: "completed",
      reason: "latest turn completed",
    };
  }

  return {
    state: "idle",
    reason: thread.session?.status ? `session ${thread.session.status}` : "no active turn",
  };
}

export function selectThreadChildren(
  threads: readonly OrchestrationThreadShell[],
  parentThreadId: string,
  recursive: boolean,
): OrchestrationThreadShell[] {
  const parents = new Set([parentThreadId]);
  if (recursive) {
    const children = new Map<string, OrchestrationThreadShell[]>();
    for (const thread of threads) {
      if (thread.parentThreadId == null) continue;
      const siblings = children.get(thread.parentThreadId) ?? [];
      siblings.push(thread);
      children.set(thread.parentThreadId, siblings);
    }
    for (const id of parents) {
      for (const child of children.get(id) ?? []) parents.add(child.id);
    }
  }
  return threads.filter(
    (thread) =>
      thread.id !== parentThreadId &&
      thread.parentThreadId != null &&
      parents.has(thread.parentThreadId),
  );
}

export function selectRemoteThreadChildren(
  threads: readonly OrchestrationThreadShell[],
  parent: { environmentId: string; threadId: string },
  recursive = false,
): OrchestrationThreadShell[] {
  const direct = threads.filter(
    (thread) =>
      thread.remoteParent?.environmentId === parent.environmentId &&
      thread.remoteParent.threadId === parent.threadId,
  );
  if (!recursive) return direct;
  const ids = new Set(
    direct.flatMap((thread) => [
      thread.id,
      ...selectThreadChildren(threads, thread.id, true).map((child) => child.id),
    ]),
  );
  return threads.filter((thread) => ids.has(thread.id));
}

export function formatThreadLine(
  thread: OrchestrationThread | OrchestrationThreadShell,
  parentTitle?: string,
): string {
  const status = classifyThread(thread);
  return [
    thread.id,
    `[${status.state}]`,
    thread.title,
    thread.projectId,
    `settled=${thread.settledOverride === "settled"}`,
    `pinned=${thread.pinnedAt != null}`,
    `order=${thread.pinnedAt != null ? "pinned" : "active"}:${
      (thread.pinnedAt != null ? thread.pinOrderKey : thread.activeOrderKey) ?? "automatic"
    }`,
    thread.parentThreadId
      ? `parent=${thread.parentThreadId}${parentTitle ? ` (${parentTitle})` : ""}`
      : "parent=none",
    ...(thread.remoteParent
      ? [`remote-parent=${thread.remoteParent.environmentId}/${thread.remoteParent.threadId}`]
      : []),
    status.reason,
  ].join(" ");
}
