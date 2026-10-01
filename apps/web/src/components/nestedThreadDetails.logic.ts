import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

export function nestedThreadStatus(thread: EnvironmentThreadShell) {
  if (thread.settledOverride === "settled") return "settled";
  const own = resolveSidebarThreadStatus(thread);
  if (own === "input") return "input";
  if (own === "approval") return "approval";
  if (own === "failed" || thread.latestTurn?.state === "error") return "error";
  if (own === "working" || own === "monitoring") return "working";
  if (thread.latestTurn?.state === "completed") return "completed";
  if (thread.latestTurn?.state === "interrupted") return "interrupted";
  return "ready";
}

export function nestedThreadDuration(thread: EnvironmentThreadShell, now: string): string {
  const turn = thread.latestTurn;
  if (!turn) return "";
  const start = Date.parse(turn.startedAt ?? turn.requestedAt);
  const end = Date.parse(turn.completedAt ?? now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
