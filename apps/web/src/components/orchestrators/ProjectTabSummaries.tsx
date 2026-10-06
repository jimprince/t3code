import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { ArrowRightIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { projectRoadmapQuery } from "../../state/projectRoadmap";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { groupProjectIssues, PROJECT_ISSUE_LANES } from "./projectIssuesBoard.logic";
import { ProjectQueryState } from "./ProjectQueryState";
import { roadmapColumns } from "./projectRoadmap.logic";
import { issueKey } from "./projectRequests.logic";
import { useNeedsYou } from "./ProjectRequestsSection";

function SummaryLine({
  title,
  children,
  onOpen,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onOpen: () => void;
}) {
  return (
    <section className="flex items-center gap-3 border-t border-border pt-3 text-sm">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <span className="min-w-0 flex-1 truncate text-foreground/90">{children}</span>
      <Button size="xs" variant="ghost-muted" onClick={onOpen}>
        Open {title.toLowerCase()}
        <ArrowRightIcon />
      </Button>
    </section>
  );
}

/** "fork.25: 4 · fork.26: 2" on the Dashboard, linking to the Roadmap tab; Later stays off. */
export function ProjectRoadmapSummary({
  summary,
  onOpen,
}: {
  readonly summary: OrchestratorSummary;
  readonly onOpen: () => void;
}) {
  const roadmap = useEnvironmentQuery(
    projectRoadmapQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
  const text = useMemo(() => {
    if (!roadmap.data) return null;
    if (!roadmap.data.tracker) return "No tracker repository";
    return roadmapColumns(roadmap.data)
      .filter((column) => column.target.kind !== "later")
      .map((column) => `${column.title}: ${column.items.length}`)
      .join(" · ");
  }, [roadmap.data]);
  return (
    <SummaryLine title="Roadmap" onOpen={onOpen}>
      {text ?? (
        <ProjectQueryState inline what="roadmap" error={roadmap.error} onRetry={roadmap.refresh} />
      )}
    </SummaryLine>
  );
}

/** Issue counts per board lane on the Dashboard, linking to the Issues tab. */
export function ProjectIssuesSummary({
  summary,
  onOpen,
}: {
  readonly summary: OrchestratorSummary;
  readonly onOpen: () => void;
}) {
  const { items, query } = useNeedsYou(summary);
  const text = useMemo(() => {
    if (!query.data) return null;
    // Later (parked) issues stay off the Dashboard.
    const open = query.data.issues.filter(
      (issue) => !issue.labels.some((label) => label.toLowerCase() === "parked"),
    );
    const { lanes, backlog } = groupProjectIssues(
      open,
      new Map(items.map((item) => [issueKey(item.issue), item.group])),
    );
    return [
      ...PROJECT_ISSUE_LANES.map((lane) => `${lane.title}: ${lanes[lane.lane].length}`),
      `Backlog: ${backlog.length}`,
    ].join(" · ");
  }, [items, query.data]);
  return (
    <SummaryLine title="Issues" onOpen={onOpen}>
      {text ?? (
        <ProjectQueryState inline what="issues" error={query.error} onRetry={query.refresh} />
      )}
    </SummaryLine>
  );
}
