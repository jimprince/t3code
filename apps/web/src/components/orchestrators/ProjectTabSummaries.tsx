import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { ArrowRightIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { projectRoadmapQuery } from "../../state/projectRoadmap";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { groupProjectIssues, PROJECT_ISSUE_LANES } from "./projectIssuesBoard.logic";
import { ProjectQueryState } from "./ProjectQueryState";
import { deriveHorizon, formatEpicProgress } from "./projectHorizon.logic";
import { TASK_STATUS_LABEL } from "./projectRequests.logic";
import { useTaskStatuses } from "./ProjectRequestsSection";

function SummaryLine({
  title,
  children,
  onOpen,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onOpen: (() => void) | null;
}) {
  return (
    <section className="flex items-center gap-3 border-t border-border pt-3 text-sm">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <span className="min-w-0 flex-1 truncate text-foreground/90">{children}</span>
      {onOpen ? (
        <Button size="xs" variant="ghost-muted" onClick={onOpen}>
          Open {title.toLowerCase()}
          <ArrowRightIcon />
        </Button>
      ) : null}
    </section>
  );
}

/**
 * Where we're going, on the Dashboard: the next release (its outcome, "N of M
 * done", the task to deliver next), its epics as "1 of 4 · Building", and
 * everything after it as one "Later (68)" line, linking to the Roadmap tab.
 */
export function ProjectRoadmapSummary({
  summary,
  onOpen,
}: {
  readonly summary: OrchestratorSummary;
  /** Null when no tab holds the roadmap board. */
  readonly onOpen: (() => void) | null;
}) {
  const roadmap = useEnvironmentQuery(
    projectRoadmapQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
  const { statuses } = useTaskStatuses(summary);
  const tracker = roadmap.data?.tracker ?? null;
  const horizon = useMemo(() => {
    if (!roadmap.data || !tracker) return null;
    return deriveHorizon(
      roadmap.data,
      (number) => statuses.get(`${tracker.repository}#${number}`) ?? "pending",
    );
  }, [roadmap.data, statuses, tracker]);
  if (!roadmap.data) {
    return (
      <SummaryLine title="Roadmap" onOpen={onOpen}>
        <ProjectQueryState inline what="roadmap" error={roadmap.error} onRetry={roadmap.refresh} />
      </SummaryLine>
    );
  }
  if (!horizon) {
    return (
      <SummaryLine title="Roadmap" onOpen={onOpen}>
        No tracker repository
      </SummaryLine>
    );
  }
  return (
    <section className="border-t border-border pt-3 text-sm">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Where we're going
        </h2>
        <span className="min-w-0 flex-1" />
        {onOpen ? (
          <Button size="xs" variant="ghost-muted" onClick={onOpen}>
            Open roadmap
            <ArrowRightIcon />
          </Button>
        ) : null}
      </div>
      <ul className="mt-1 divide-y divide-border">
        <li className="flex items-baseline gap-3 py-1.5">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{horizon.version ?? "Next release"}</span>
            {horizon.outcome ? (
              <span className="text-foreground/80"> · {horizon.outcome}</span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {horizon.counts.complete} of {horizon.counts.total} done
          </span>
        </li>
        {horizon.next ? (
          <li className="flex items-baseline gap-3 py-1.5">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">
              {TASK_STATUS_LABEL[horizon.next.status]}
            </span>
            <a
              href={horizon.next.item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate hover:underline"
            >
              {horizon.next.item.title}
            </a>
          </li>
        ) : null}
        {horizon.epics.map(({ item, phase }) => (
          <li key={item.number} className="flex items-baseline gap-3 py-1.5">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate hover:underline"
            >
              {item.title}
            </a>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatEpicProgress(item.epic!, phase)}
            </span>
          </li>
        ))}
        {horizon.later > 0 ? (
          <li className="py-1.5 text-muted-foreground">Later ({horizon.later})</li>
        ) : null}
      </ul>
    </section>
  );
}

/** Task counts per status on the Dashboard, linking to the Tasks tab. */
export function ProjectIssuesSummary({
  summary,
  onOpen,
  includeLater = false,
}: {
  readonly summary: OrchestratorSummary;
  /** Null when no tab holds the Tasks board. */
  readonly onOpen: (() => void) | null;
  readonly includeLater?: boolean;
}) {
  const { statuses, query } = useTaskStatuses(summary);
  const text = useMemo(() => {
    if (!query.data) return null;
    // Later (parked) issues stay off the Dashboard.
    const open = query.data.issues.filter(
      (issue) => includeLater || !issue.labels.some((label) => label.toLowerCase() === "parked"),
    );
    const { lanes, backlog } = groupProjectIssues(open, statuses);
    return [
      ...PROJECT_ISSUE_LANES.map((lane) => `${lane.title}: ${lanes[lane.lane].length}`),
      `Backlog: ${backlog.length}`,
    ].join(" · ");
  }, [includeLater, query.data, statuses]);
  return (
    <SummaryLine title="Tasks" onOpen={onOpen}>
      {text ?? (
        <ProjectQueryState inline what="tasks" error={query.error} onRetry={query.refresh} />
      )}
    </SummaryLine>
  );
}
