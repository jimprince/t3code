import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export type SupervisionWorkerStatus =
  | "working"
  | "input"
  | "approval"
  | "completed"
  | "error"
  | "settled"
  | "interrupted"
  | "ready";

type StatusInput = Pick<
  EnvironmentThreadShell,
  "settledOverride" | "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "latestRun"
>;

export function supervisionWorkerStatus(thread: StatusInput): SupervisionWorkerStatus {
  if (thread.settledOverride === "settled") return "settled";
  const own = resolveSidebarThreadStatus(thread);
  if (own === "input" || own === "approval") return own;
  if (own === "failed" || own === "limited" || thread.latestRun?.status === "failed")
    return "error";
  if (own === "working") return "working";
  if (thread.latestRun?.status === "completed") return "completed";
  if (thread.latestRun?.status === "interrupted" || thread.latestRun?.status === "cancelled")
    return "interrupted";
  return "ready";
}

export function supervisionWorkerDuration(
  thread: Pick<EnvironmentThreadShell, "latestRun">,
  now: string,
): string {
  const run = thread.latestRun;
  if (!run) return "";
  const start = Date.parse(run.startedAt ?? run.requestedAt ?? "");
  const end = Date.parse(run.completedAt ?? now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatWorkerCount(count: number, singular: string, plural = `${singular}s`) {
  return `${compactNumber.format(count)} ${count === 1 ? singular : plural}`;
}

export function supervisionWorkerOutput(
  thread: Pick<EnvironmentThreadShell, "source" | "runtime">,
  fallback: string,
): string {
  return (
    thread.source.workerSummary?.output?.split(/\r?\n/, 1)[0] ||
    thread.runtime?.lastError ||
    fallback
  );
}

export function supervisionWorkerMetadata(
  thread: Pick<EnvironmentThreadShell, "source" | "branch" | "worktreePath" | "modelSelection">,
  providerName: string | undefined,
  includePaths: boolean,
): string {
  const summary = thread.source.workerSummary;
  return [
    thread.modelSelection.model,
    providerName,
    summary?.usedTokens == null ? null : formatWorkerCount(summary.usedTokens, "token"),
    summary ? formatWorkerCount(summary.toolCount, "tool") : null,
    includePaths ? thread.branch : null,
    includePaths ? thread.worktreePath : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
