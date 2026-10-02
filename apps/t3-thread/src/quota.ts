import type { OrchestrationThread } from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Persisted, current-turn quota evidence. Old adapters only persisted their error label. */
export function threadQuotaBlock(thread: OrchestrationThread): { resetsAt: number | null } | null {
  const turn = thread.latestTurn;
  if (!turn || turn.state === "completed") return null;
  const rejected = new Map<string, number | null>();
  let codedError = false;
  let legacyError = false;
  const quotaLabel = /^(?:Claude|Codex|Grok) usage limit reached\./;
  for (const activity of thread.activities) {
    if (activity.turnId !== turn.turnId) continue;
    const payload = record(activity.payload);
    if (activity.kind === "runtime.error" && payload?.code === "usage_limit") codedError = true;
    if (
      activity.kind === "runtime.error" &&
      typeof payload?.message === "string" &&
      quotaLabel.test(payload.message)
    )
      legacyError = true;
    const detail = record(payload?.detail);
    if (activity.kind !== "runtime.warning" || !detail || typeof detail.rateLimitType !== "string")
      continue;
    const overage =
      detail.isUsingOverage === true ||
      detail.overageInUse === true ||
      detail.overageStatus === "allowed" ||
      detail.overageStatus === "allowed_warning";
    if (detail.status === "rejected" && !overage) {
      const reset = typeof detail.resetsAt === "number" ? detail.resetsAt * 1000 : NaN;
      // A reset already passed when this failure occurred cannot authorize another retry.
      const failedAt = Date.parse(turn.completedAt ?? String(activity.createdAt));
      rejected.set(detail.rateLimitType, Number.isFinite(reset) && reset > failedAt ? reset : null);
    } else if (detail.status === "allowed" || detail.status === "allowed_warning" || overage) {
      rejected.delete(detail.rateLimitType);
    }
  }
  if (rejected.size > 0) {
    const resets = [...rejected.values()];
    return {
      resetsAt: resets.some((reset) => reset === null) ? null : Math.max(...(resets as number[])),
    };
  }
  if (turn.state !== "error") return null;
  // Narrow compatibility fallback for existing persisted turns, never arbitrary assistant prose.
  return codedError || legacyError || quotaLabel.test(thread.session?.lastError ?? "")
    ? { resetsAt: null }
    : null;
}
