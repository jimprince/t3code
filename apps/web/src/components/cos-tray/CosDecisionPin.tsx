import { liveAttention } from "@t3tools/client-runtime/dashboard/live";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useDashboardData } from "../../state/dashboard";
import { useLiveRuntimeRequests } from "../../state/liveRuntimeRequests";
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
  const { data, snapshotSource } = useDashboardData();
  const live = useLiveRuntimeRequests();
  const now = useMinuteClock();
  const answers = useDecisionAnswers();

  const rows = useMemo<ReadonlyArray<DecisionRow>>(() => {
    const all = data.projects
      .filter((entry) => entry.environmentId === environmentId)
      .flatMap((entry) =>
        liveAttention(entry.environmentId, entry.project.attention, live, snapshotSource).map(
          (attention) => ({
            key: `${entry.key}|${attention.id}`,
            scoped: entry,
            attention,
          }),
        ),
      );
    return rankDecisions(all.map((row) => row.attention)).flatMap((attention) => {
      const row = all.find((candidate) => candidate.attention === attention);
      return row ? [row] : [];
    });
  }, [data.projects, environmentId, live, snapshotSource]);

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
  // The pin follows the decision it shows by key, so an answered one stays up with its receipt
  // (it moves to the end of `shown` once the snapshot drops it) instead of jumping to the next.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const followed = activeKey === null ? -1 : shown.findIndex((row) => row.key === activeKey);
  const at = followed >= 0 ? followed : Math.min(index, Math.max(0, shown.length - 1));
  const first = shown[0]?.key ?? null;
  // Start following the first decision at once, so answering it does not move the pin on.
  if (activeKey === null && first !== null) setActiveKey(first);
  const goTo = (target: number) => {
    setIndex(target);
    setActiveKey(shown[target]?.key ?? null);
  };

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
                onClick={() => goTo(at - 1)}
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
                onClick={() => goTo(at + 1)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          ) : null}
        </div>
        <div className="max-h-[40dvh] overflow-y-auto">
          <DecisionCard key={row.key} row={row} compact />
        </div>
      </div>
    </DashboardUiProvider>
  );
}
