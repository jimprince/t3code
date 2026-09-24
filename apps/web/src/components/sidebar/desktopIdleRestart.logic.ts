import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

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
  | "session"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
>;

/**
 * Whether restarting the desktop app would interrupt this thread's agent.
 * Agents waiting on the user (approvals, questions) do not hold a restart:
 * they can wait indefinitely and the thread survives. Background work and
 * queued messages do; the queue lives only in this renderer.
 */
export function isThreadBlockingIdleRestart(
  thread: IdleRestartThread,
  queuedMessages: ReadonlyArray<Pick<QueuedComposerMessage, "holdUntilUserAction">>,
): boolean {
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return true;
  }
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
}): number {
  let count = 0;
  for (const thread of input.threads) {
    if (!input.localEnvironmentIds.has(thread.environmentId)) continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (isThreadBlockingIdleRestart(thread, input.queuesByThreadKey[key] ?? [])) count += 1;
  }
  return count;
}

export function idleRestartTooltip(busyAgentCount: number): string {
  if (busyAgentCount === 0) return "Restarting to install the update once agents stay idle.";
  const agents = busyAgentCount === 1 ? "1 agent finishes" : `${busyAgentCount} agents finish`;
  return `Restarts to install the update when ${agents}. Click to cancel.`;
}
