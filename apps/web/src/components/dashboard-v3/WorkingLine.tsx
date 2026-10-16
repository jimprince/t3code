import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DashboardWorker } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { resolveThreadLinkTarget } from "../../state/threadLinks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { useDashboardUi } from "./context";
import type { ScopedProject } from "./dashboard.logic";
import { workingSummary } from "./dashboard.logic";

/**
 * "Working: <thread> · 12m" under a row that threads are working on right now, each name opening
 * its thread. Nothing renders for a row without workers, so such rows keep their height.
 */
export function WorkingLine({
  scoped,
  workers,
  count,
  className,
}: {
  readonly scoped: ScopedProject;
  readonly workers: ReadonlyArray<DashboardWorker> | undefined;
  /** How many threads work on the row in all; `workers` may be capped. */
  readonly count?: number | undefined;
  /** Placement in the row's layout. */
  readonly className?: string;
}) {
  const { now } = useDashboardUi();
  const navigate = useNavigate();
  const { named, more } = workingSummary(workers, now, count);
  if (named.length === 0) return null;
  const open = (worker: DashboardWorker) => {
    const thread = resolveThreadLinkTarget(scoped.environmentId, worker.threadId);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
    });
  };
  return (
    <span
      data-testid="working-line"
      className={cn(
        "flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span>Working:</span>
      {named.map(({ worker, detail }, index) => (
        <span key={worker.threadId} className="flex min-w-0 max-w-full items-baseline gap-x-1">
          {" "}
          <button
            type="button"
            className="line-clamp-2 min-w-0 break-words text-left text-foreground hover:underline"
            onClick={() => open(worker)}
          >
            {worker.title}
          </button>{" "}
          <span className="shrink-0">
            · {detail}
            {index < named.length - 1 ? "," : ""}
          </span>
        </span>
      ))}
      {more > 0 ? <span className="shrink-0"> +{more}</span> : null}
    </span>
  );
}
