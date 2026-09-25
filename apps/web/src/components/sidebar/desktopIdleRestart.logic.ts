import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import type { QueuedComposerMessage } from "../../queuedMessageStore";

/**
 * How long every local agent must stay idle before a scheduled restart fires.
 * It covers the gap between a finished turn and the next queued message.
 */
export const IDLE_RESTART_GRACE_MS = 15_000;

type IdleRestartThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "session"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
>;

/**
 * Whether restarting the desktop app would interrupt this thread's agent.
 * Agents waiting on the user (approvals, questions) do not hold a restart:
 * they can wait indefinitely and the thread survives. Background work and
 * queued messages do; the queue lives only in this renderer. Monitors do
 * unless the server resumes them after the restart (`resumesMonitoring`).
 */
export function isThreadBlockingIdleRestart(
  thread: IdleRestartThread,
  queuedMessages: ReadonlyArray<Pick<QueuedComposerMessage, "holdUntilUserAction">>,
  resumesMonitoring = false,
): boolean {
  if (thread.backgroundLiveness === "working") return true;
  if (thread.backgroundLiveness === "monitoring" && !resumesMonitoring) return true;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (queuedMessages.some((message) => !message.holdUntilUserAction)) return true;
  const status = thread.session?.status;
  return status === "running" || status === "starting";
}

/**
 * Counts agents a restart would interrupt. Only environments hosted by this
 * desktop app (the primary backend and desktop-local secondaries such as WSL)
 * stop on restart; remote agents keep running and are ignored.
 */
export function countAgentsBlockingIdleRestart(input: {
  readonly threads: ReadonlyArray<IdleRestartThread>;
  readonly localEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuesByThreadKey: Readonly<
    Record<string, ReadonlyArray<Pick<QueuedComposerMessage, "holdUntilUserAction">>>
  >;
  readonly resumesMonitoring?: (thread: IdleRestartThread) => boolean;
}): number {
  let count = 0;
  for (const thread of input.threads) {
    if (!input.localEnvironmentIds.has(thread.environmentId)) continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const resumesMonitoring = input.resumesMonitoring?.(thread) ?? false;
    if (
      isThreadBlockingIdleRestart(thread, input.queuesByThreadKey[key] ?? [], resumesMonitoring)
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Which threads' monitors survive a restart: their server resumes background
 * work, and "Continue threads after restarts" is on for the thread's project.
 */
export function makeResumesMonitoring(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly serverConfig: Pick<ServerConfig, "environment" | "settings"> | null;
  }>,
): (thread: Pick<IdleRestartThread, "environmentId" | "projectId">) => boolean {
  const settingsByEnvironment = new Map<EnvironmentId, ServerSettings>();
  for (const { environmentId, serverConfig } of environments) {
    if (serverConfig?.environment.capabilities.backgroundWorkResume === true) {
      settingsByEnvironment.set(environmentId, serverConfig.settings);
    }
  }
  return (thread) => {
    const settings = settingsByEnvironment.get(thread.environmentId);
    return (
      settings !== undefined &&
      resolveProjectSettings(settings, thread.projectId).settings.continueThreadsAfterServerUpdate
    );
  };
}

export function idleRestartTooltip(busyAgentCount: number): string {
  if (busyAgentCount === 0) return "Restarting to install the update once agents stay idle.";
  const agents = busyAgentCount === 1 ? "1 agent finishes" : `${busyAgentCount} agents finish`;
  return `Restarts to install the update when ${agents}. Click to cancel.`;
}
