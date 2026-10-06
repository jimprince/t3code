import type { EnvironmentThreadShell } from "../state/models.ts";
export type DesktopWorkThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "projectId"
  | "id"
  | "runtime"
  | "latestRun"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingBackgroundTasks"
  | "codexNativeGoal"
>;
/** Native runtime shells include queued/preparing work even before a provider exists. */
export function desktopThreadHasWork(
  thread: DesktopWorkThread,
  resumesMonitoring = false,
): boolean {
  if (thread.codexNativeGoal?.status === "active") return true;
  if (thread.pendingBackgroundTasks.some((task) => task.kind !== "monitor" || !resumesMonitoring))
    return true;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  const active = ["preparing", "queued", "starting", "running", "waiting"];
  return (
    active.includes(thread.runtime?.status ?? "idle") ||
    active.includes(thread.latestRun?.status ?? "idle")
  );
}
