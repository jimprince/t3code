import { DateTime } from "effect";
import type { OrchestrationThread } from "../types.js";

const progressTypes = new Set([
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "todo_list",
  "proposed_plan",
  "compaction",
  "subagent",
]);

/** Progress timestamps come from native provider items, never shell polling updates. */
export function latestRunProgress(thread: OrchestrationThread): string | null {
  const projection = thread.projection;
  if (!projection) return null;
  const run = projection.runs.find((candidate) => candidate.id === thread.latestTurn?.turnId);
  if (!run || run.status !== "running") return null;
  const provider = projection.providerThreads.find(
    (provider) => provider.id === projection.thread.activeProviderThreadId,
  );
  const session = projection.providerSessions.find(
    (session) => session.id === provider?.providerSessionId,
  );
  if (session && !["starting", "running"].includes(session.status)) return null;
  let latest = DateTime.toEpochMillis(run.startedAt ?? run.requestedAt);
  for (const item of projection.turnItems) {
    if (item.runId !== run.id || !progressTypes.has(item.type)) continue;
    latest = Math.max(latest, DateTime.toEpochMillis(item.updatedAt));
  }
  return new Date(latest).toISOString();
}
