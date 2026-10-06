import { desktopThreadHasWork, type DesktopWorkThread } from "@t3tools/client-runtime/fork/desktop-work-state";
import type { EnvironmentId } from "@t3tools/contracts";
export const IDLE_RESTART_GRACE_MS = 15_000;
export const isThreadBlockingIdleRestart = desktopThreadHasWork;
/** Only the desktop's own environments stop when it installs an update. */
export function countAgentsBlockingIdleRestart(input: {
  readonly threads: ReadonlyArray<DesktopWorkThread>;
  readonly localEnvironmentIds: ReadonlySet<EnvironmentId>;
}): number {
  return input.threads.filter((thread) => input.localEnvironmentIds.has(thread.environmentId) && desktopThreadHasWork(thread)).length;
}
export function idleRestartTooltip(busyAgentCount: number): string {
  if (busyAgentCount === 0) return "Restarting to install the update once agents stay idle.";
  const agents = busyAgentCount === 1 ? "1 agent finishes" : `${busyAgentCount} agents finish`;
  return `Restarts to install the update when ${agents}. Click to cancel.`;
}
