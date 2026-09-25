import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isTerminalSubagentStatus,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveSettledThreadTimestamp } from "@t3tools/client-runtime/state/thread-sort";

/**
 * One Agents-panel row: a nested thread, a workflow run, or a direct subagent
 * spawn. Keys are namespaced so a thread and a spawn can never collide.
 */
export type AgentsPanelEntry =
  | { readonly kind: "thread"; readonly key: string; readonly thread: EnvironmentThreadShell }
  | { readonly kind: "workflow"; readonly key: string; readonly group: AgentPanelWorkflowGroup }
  | { readonly kind: "agent"; readonly key: string; readonly agent: RuntimeSubagent };

/**
 * Settled means nobody needs to act on the row. A nested thread follows the
 * server lifecycle (manual, supervisor, or automatic settlement after the
 * configured idle days); a spawn or workflow settles when it reaches a
 * terminal status. Idle spawns are resumable, so they stay active.
 */
export function isAgentsPanelEntrySettled(entry: AgentsPanelEntry): boolean {
  switch (entry.kind) {
    case "thread":
      return entry.thread.settledOverride === "settled";
    case "workflow":
      return isTerminalSubagentStatus(entry.group.workflow.status);
    case "agent":
      return isTerminalSubagentStatus(entry.agent.status);
  }
}

function startedAt(entry: AgentsPanelEntry): string {
  switch (entry.kind) {
    case "thread":
      return entry.thread.createdAt;
    case "workflow":
      return entry.group.workflow.firstSeenAt;
    case "agent":
      return entry.agent.firstSeenAt;
  }
}

function finishedAtMs(entry: AgentsPanelEntry): number {
  const value =
    entry.kind === "thread"
      ? resolveSettledThreadTimestamp(entry.thread)
      : entry.kind === "workflow"
        ? (entry.group.workflow.completedAt ?? entry.group.workflow.updatedAt)
        : (entry.agent.completedAt ?? entry.agent.updatedAt);
  const ms = value === null ? Number.NaN : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Splits the panel into one active list and a Settled shelf. Active rows keep
 * spawn order so completion never reshuffles them; the shelf lists the most
 * recently finished first, like the sidebar's. `keepActiveKeys` holds rows the
 * viewer already saw active: they stay in place when they settle and move to
 * the shelf the next time the panel mounts.
 */
export function shelveAgentsPanelEntries(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly keepActiveKeys: ReadonlySet<string>;
}): { readonly active: AgentsPanelEntry[]; readonly settled: AgentsPanelEntry[] } {
  const entries: AgentsPanelEntry[] = [
    ...input.threads.map((thread) => ({
      kind: "thread" as const,
      key: `thread:${thread.environmentId}:${thread.id}`,
      thread,
    })),
    ...input.workflows.map((group) => ({
      kind: "workflow" as const,
      key: `workflow:${group.workflow.id}`,
      group,
    })),
    ...input.directAgents.map((agent) => ({
      kind: "agent" as const,
      key: `agent:${agent.id}`,
      agent,
    })),
  ];
  const active: AgentsPanelEntry[] = [];
  const settled: AgentsPanelEntry[] = [];
  for (const entry of entries) {
    if (isAgentsPanelEntrySettled(entry) && !input.keepActiveKeys.has(entry.key)) {
      settled.push(entry);
    } else {
      active.push(entry);
    }
  }
  active.sort(
    (left, right) =>
      startedAt(left).localeCompare(startedAt(right)) || left.key.localeCompare(right.key),
  );
  settled.sort(
    (left, right) => finishedAtMs(right) - finishedAtMs(left) || left.key.localeCompare(right.key),
  );
  return { active, settled };
}
