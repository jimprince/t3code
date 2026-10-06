import type { EnvironmentThreadShell } from "../state/models.ts";
export type DesktopWorkThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "runtime" | "latestRun" | "hasPendingApprovals" | "hasPendingUserInput" | "pendingBackgroundTasks">;
/** Native runtime shells include queued/preparing work even before a provider exists. */
export function desktopThreadHasWork(thread: DesktopWorkThread): boolean {
  if (thread.pendingBackgroundTasks.length > 0) return true;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  const active = ["preparing", "queued", "starting", "running", "waiting"];
  return active.includes(thread.runtime?.status ?? "idle") || active.includes(thread.latestRun?.status ?? "idle");
}
