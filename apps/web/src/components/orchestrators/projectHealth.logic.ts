import type { ProjectHealth, ProjectHealthStatus } from "@t3tools/contracts";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";

export const HEALTH_LABEL: Record<ProjectHealthStatus, string> = {
  "on-track": "On track",
  "at-risk": "At risk",
  "off-track": "Off track",
  "waiting-on-you": "Waiting on you",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest change to the project's work: a worker thread or a task link. */
export function latestWorkChangeAt(summary: OrchestratorSummary): string | null {
  const times = [
    ...summary.descendants.map((thread) => thread.updatedAt),
    ...summary.issues.map((issue) => issue.linkedAt),
  ];
  return times.reduce<string | null>(
    (latest, time) => (latest === null || time > latest ? time : latest),
    null,
  );
}

/** A health line is stale when it is older than a day or older than the newest work change. */
export function isHealthStale(
  health: ProjectHealth,
  latestChangeAt: string | null,
  nowMs: number,
): boolean {
  const updatedMs = Date.parse(health.updatedAt);
  if (nowMs - updatedMs > DAY_MS) return true;
  return latestChangeAt !== null && Date.parse(latestChangeAt) > updatedMs;
}
