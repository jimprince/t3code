import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useDashboardData } from "../../state/dashboard";
import type { DashboardUi, DecisionRow } from "../dashboard-v3/context";
import { DashboardUiProvider } from "../dashboard-v3/context";
import { rankDecisions } from "../dashboard-v3/dashboard.logic";
import { DecisionCard } from "../dashboard-v3/decisions";
import { useMinuteClock } from "../dashboard-v3/prefs";
import { useDecisionAnswers } from "../dashboard-v3/useDecisionAnswers";
import { Button } from "../ui/button";

/**
 * The first open decision pinned above the conversation, "1 of N" with a way through the rest.
 * It is the Dashboard's own decision card answering through the same services; the tray only
 * supplies the slice of the Dashboard context that card reads (the clock, the answers, and a way
 * to open a task).
 */
export function CosDecisionPin({
  environmentId,
  id,
  open,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { data } = useDashboardData();
  const now = useMinuteClock();
  const answers = useDecisionAnswers();

  const rows = useMemo<ReadonlyArray<DecisionRow>>(() => {
    const all = data.projects
      .filter((entry) => entry.environmentId === environmentId)
      .flatMap((entry) =>
        entry.project.attention.map((attention) => ({
          key: `${entry.key}|${attention.id}`,
          scoped: entry,
          attention,
        })),
      );
    return rankDecisions(all.map((row) => row.attention)).flatMap((attention) => {
      const row = all.find((candidate) => candidate.attention === attention);
      return row ? [row] : [];
    });
  }, [data.projects, environmentId]);

  const openKeys = useMemo(() => new Set(rows.map((row) => row.key)), [rows]);
  const reconcile = answers.reconcile;
  useEffect(() => reconcile(openKeys), [reconcile, openKeys]);

  // An answered card that already left the snapshot stays on screen showing what happened.
  const shown = useMemo(
    () => [
      ...rows,
      ...[...answers.records.values()]
        .filter((record) => !openKeys.has(record.row.key))
        .map((record) => record.row),
    ],
    [rows, answers.records, openKeys],
  );
  const [index, setIndex] = useState(0);
  const at = Math.min(index, Math.max(0, shown.length - 1));

  const ui = useMemo(
    () =>
      ({
        now,
        answers,
        openTask: (_scoped, task) => {
          if (task.url) window.open(task.url, "_blank", "noopener,noreferrer");
        },
      }) as Pick<DashboardUi, "now" | "answers" | "openTask"> as DashboardUi,
    [now, answers],
  );

  const row = shown[at];
  if (!row) return null;
  return (
    <DashboardUiProvider value={ui}>
      <div
        id={id}
        data-testid="cos-decision-pin"
        // Keep answer delivery and Undo alive when only the view is collapsed.
        hidden={!open}
        className="shrink-0 border-b border-border px-3 py-1"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            <XIcon />
            Hide decisions
          </Button>
          {shown.length > 1 ? (
            <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous decision"
                disabled={at === 0}
                onClick={() => setIndex(at - 1)}
              >
                <ChevronLeftIcon />
              </Button>
              <span>
                {at + 1} of {shown.length}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next decision"
                disabled={at === shown.length - 1}
                onClick={() => setIndex(at + 1)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          ) : null}
        </div>
        <div className="max-h-[40dvh] overflow-y-auto">
          <DecisionCard key={row.key} row={row} />
        </div>
      </div>
    </DashboardUiProvider>
  );
}
