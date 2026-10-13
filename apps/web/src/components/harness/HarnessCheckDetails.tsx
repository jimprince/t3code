import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildHarnessRunRows,
  type HarnessCheckView,
} from "@t3tools/client-runtime/state/harness-view";
import type { HarnessThreadLink } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";

/** Opens a run's or owner's thread; the link carries its own environment, so remote runs resolve. */
function useOpenThreadLink() {
  const navigate = useNavigate();
  return (link: HarnessThreadLink) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(link.environmentId, link.threadId)),
    });
}

function LinkButton({
  label,
  onOpen,
  touch,
}: {
  readonly label: string;
  readonly onOpen: () => void;
  readonly touch: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "shrink-0 cursor-pointer rounded px-1.5 text-info-foreground hover:bg-sidebar-row-hover hover:underline",
        touch ? "min-h-11" : "h-6",
      )}
      onClick={onOpen}
    >
      {label}
    </button>
  );
}

/**
 * Why a check reads as it does, and its retained runs: time, outcome, findings count or "unknown",
 * and a link to each run's thread. Read-only; editing stays on the automations page.
 */
export function HarnessCheckDetails({
  check,
  now,
  touch,
}: {
  readonly check: HarnessCheckView;
  readonly now: number;
  /** Phone drawer: 44 px rows. */
  readonly touch: boolean;
}) {
  const openThread = useOpenThreadLink();
  const runs = buildHarnessRunRows(check.routine, now);
  const { routine, errors } = check;
  return (
    <div className="flex flex-col gap-1.5 px-2.5 pb-2 text-3xs text-sidebar-muted-foreground">
      <p className="break-words text-sidebar-foreground">{check.evidence}</p>
      {check.whatItChecks ? <p className="break-words">{check.whatItChecks}</p> : null}
      <p>
        Findings per run: {errors.known ? errors.label : "unknown (no run reported a count)"}
        {errors.failedLabel ? ` · ${errors.failedLabel}` : ""}
      </p>
      {check.owner ? (
        <div className="flex items-center gap-1">
          <span>Owner thread</span>
          <LinkButton
            label="Open"
            touch={touch}
            onOpen={() => openThread(check.owner as HarnessThreadLink)}
          />
        </div>
      ) : null}
      {runs.length === 0 ? (
        <p>No runs retained.</p>
      ) : (
        <ul aria-label={`Runs of ${check.name}`} className="flex flex-col">
          {runs.map((run) => (
            <li
              key={run.key}
              className={cn("flex items-center gap-2 tabular-nums", touch ? "min-h-11" : "min-h-6")}
            >
              <span className="w-20 shrink-0">{run.timeLabel}</span>
              <span className={cn("min-w-0 flex-1 truncate", run.failed && "text-error")}>
                {run.outcomeLabel}
              </span>
              <span className="shrink-0">{run.errorsLabel}</span>
              {run.thread ? (
                <LinkButton
                  label="Open"
                  touch={touch}
                  onOpen={() => openThread(run.thread as HarnessThreadLink)}
                />
              ) : (
                <span className="w-9 shrink-0 text-right">none</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {routine.historyCoverage.truncated ? (
        <p className="break-words">{routine.historyCoverage.evidence}</p>
      ) : null}
    </div>
  );
}
