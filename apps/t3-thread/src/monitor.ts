import { classifyThread } from "./status.js";
import type { AgentState, OrchestrationMessage, OrchestrationThread, SavedAgent } from "./types.js";

export interface AgentOverview {
  name: string;
  environment: string;
  threadId: string;
  title: string;
  state: AgentState;
  reason: string;
  hasNewOutput: boolean;
  latestAssistantMessageId: string | null;
  latestAssistantPreview: string | null;
}

export function getLatestAssistantMessage(thread: OrchestrationThread): OrchestrationMessage | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const candidate = thread.messages[index];
    if (candidate.role === "assistant") {
      return candidate;
    }
  }
  return null;
}

export function getLatestTurnAssistantMessage(thread: OrchestrationThread): OrchestrationMessage | null {
  const turnId = thread.latestTurn?.turnId ?? null;
  if (turnId) {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const candidate = thread.messages[index];
      if (candidate.role === "assistant" && candidate.turnId === turnId) {
        return candidate;
      }
    }
  }
  const pinnedId = thread.latestTurn?.assistantMessageId;
  if (pinnedId) {
    return thread.messages.find((message) => message.id === pinnedId) ?? null;
  }
  return null;
}

export function summarizeMessageText(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function hasNewAssistantOutput(agent: SavedAgent, thread: OrchestrationThread): boolean {
  const latestAssistant = getLatestAssistantMessage(thread);
  if (!latestAssistant) {
    return false;
  }
  return latestAssistant.id !== (agent.lastSeenAssistantMessageId ?? null);
}

export function buildAgentOverview(agent: SavedAgent, thread: OrchestrationThread): AgentOverview {
  const status = classifyThread(thread);
  const latestAssistant = getLatestAssistantMessage(thread);
  return {
    name: agent.name,
    environment: agent.environment,
    threadId: agent.threadId,
    title: agent.title,
    state: status.state,
    reason: status.reason,
    hasNewOutput: hasNewAssistantOutput(agent, thread),
    latestAssistantMessageId: latestAssistant?.id ?? null,
    latestAssistantPreview: latestAssistant ? summarizeMessageText(latestAssistant.text) : null,
  };
}

export function needsAttention(overview: AgentOverview): boolean {
  if (overview.state === "running") {
    return false;
  }
  return (
    overview.hasNewOutput ||
    overview.state === "needs-plan" ||
    overview.state === "error" ||
    overview.state === "interrupted"
  );
}

export function formatOverviewLine(overview: AgentOverview): string {
  const stateLabel = overview.hasNewOutput ? `${overview.state}/new` : overview.state;
  return [
    overview.name,
    `[${stateLabel}]`,
    overview.threadId,
    overview.title,
    overview.reason,
  ].join(" ");
}

export function formatInboxLine(overview: AgentOverview): string {
  return [
    formatOverviewLine(overview),
    overview.latestAssistantPreview ? `:: ${overview.latestAssistantPreview}` : "",
  ]
    .join(" ")
    .trim();
}
