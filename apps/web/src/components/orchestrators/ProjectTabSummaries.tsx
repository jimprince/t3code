import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { ArrowRightIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { projectRoadmapQuery } from "../../state/projectRoadmap";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { ProjectSection } from "./ProjectSection";
import { TaskTitle } from "./TaskLink";
import { groupProjectIssues, PROJECT_ISSUE_LANES } from "./projectIssuesBoard.logic";
import { ProjectQueryState } from "./ProjectQueryState";
import { deriveHorizon, formatEpicProgress } from "./projectHorizon.logic";
import { TASK_STATUS_LABEL } from "./projectRequests.logic";
import { useTaskStatuses } from "./ProjectRequestsSection";

/** A Dashboard summary: its heading and an "Open …" link to the tab with the full view. */
function SummaryLine({
  title,
  openLabel,
  children,
  onOpen,
}: {
  readonly title: string;
  readonly openLabel: string;
  readonly children: ReactNode;
  readonly onOpen: (() => void) | null;
}) {
  return (
    <ProjectSection
      title={title}
      action={
        onOpen ? (
          <Button size="xs" variant="ghost-muted" onClick={onOpen}>
            {openLabel}
            <ArrowRightIcon />
          </Button>
        ) : null
      }
    >
      <div className="text-sm text-foreground/90">{children}</div>
    </ProjectSection>
  );
}

/**
 * Where we're going, on the Dashboard: the next release (its outcome, "N of M
 * complete", the task to deliver next), its epics not yet under way as
 * "Planning" (Workstreams above shows the ones with work left), and everything
 * after it as one "Later (68)" line, linking to the Roadmap tab.
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
  const title = "Where we're going";
  if (!roadmap.data) {
    return (
      <SummaryLine title={title} openLabel="Open roadmap" onOpen={onOpen}>
        <ProjectQueryState inline what="roadmap" error={roadmap.error} onRetry={roadmap.refresh} />
      </SummaryLine>
    );
  }
  if (!horizon || !tracker) {
    return (
      <SummaryLine title={title} openLabel="Open roadmap" onOpen={onOpen}>
        <span className="text-muted-foreground">No task repository yet. Set one under Edit.</span>
      </SummaryLine>
    );
  }
  const task = (number: number) => ({ host: tracker.host, repository: tracker.repository, number });
  // Epics with work left are Workstreams' rows; only the ones not under way are listed here.
  const epics = horizon.epics.filter(({ item }) => (item.epic?.remaining.length ?? 0) === 0);
  return (
    <SummaryLine title={title} openLabel="Open roadmap" onOpen={onOpen}>
      <ul className="divide-y divide-border">
        <li className="flex items-baseline gap-3 py-1.5">
          <span className="min-w-0 flex-1">
            {horizon.version ?? "Next release"}
            {horizon.outcome ? (
              <span className="text-muted-foreground"> · {horizon.outcome}</span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {horizon.counts.complete} of {horizon.counts.total}{" "}
            {TASK_STATUS_LABEL.complete.toLowerCase()}
          </span>
        </li>
        {horizon.next ? (
          <li className="flex items-baseline gap-3 py-1.5">
            {/* A plain column, not StatusCell: this row has no meta line to carry it at phone width. */}
            <span className="w-24 shrink-0 text-xs text-muted-foreground">
              {TASK_STATUS_LABEL[horizon.next.status]}
            </span>
            <TaskTitle
              task={task(horizon.next.item.number)}
              url={horizon.next.item.url}
              className="min-w-0 flex-1 hover:underline"
            >
              {horizon.next.item.title}
            </TaskTitle>
          </li>
        ) : null}
        {epics.map(({ item, phase }) => (
          <li key={item.number} className="flex items-baseline gap-3 py-1.5">
            <TaskTitle
              task={task(item.number)}
              url={item.url}
              className="min-w-0 flex-1 hover:underline"
            >
              {item.title}
            </TaskTitle>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatEpicProgress(item.epic!, phase)}
            </span>
          </li>
        ))}
        {horizon.later > 0 ? (
          <li className="py-1.5 text-muted-foreground">Later ({horizon.later})</li>
        ) : null}
      </ul>
    </SummaryLine>
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
    const { lanes } = groupProjectIssues(open, statuses);
    return PROJECT_ISSUE_LANES.map((lane) => `${lane.title} ${lanes[lane.lane].length}`).join(
      " · ",
    );
  }, [includeLater, query.data, statuses]);
  return (
    <SummaryLine title="Tasks" openLabel="Open tasks" onOpen={onOpen}>
      {text ?? (
        <ProjectQueryState inline what="tasks" error={query.error} onRetry={query.refresh} />
      )}
    </SummaryLine>
  );
}
