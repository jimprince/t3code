import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { ArrowRightIcon } from "lucide-react";
import { useMemo } from "react";

import { projectIssuesQuery } from "../../state/projectIssues";
import { projectRoadmapQuery } from "../../state/projectRoadmap";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { groupProjectIssues, PROJECT_ISSUE_LANES } from "./projectIssuesBoard.logic";
import { roadmapColumns } from "./projectRoadmap.logic";

function SummaryLine({
  title,
  text,
  onOpen,
}: {
  readonly title: string;
  readonly text: string;
  readonly onOpen: () => void;
}) {
  return (
    <section className="flex items-center gap-3 border-t border-border pt-3 text-sm">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <span className="min-w-0 flex-1 truncate text-foreground/90">{text}</span>
      <Button size="xs" variant="ghost-muted" onClick={onOpen}>
        Open {title.toLowerCase()}
        <ArrowRightIcon />
      </Button>
    </section>
  );
}

/** "Next release: 4 · Later: 12" on the Dashboard, linking to the Roadmap tab. */
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
    if (!roadmap.data) return "Loading";
    if (!roadmap.data.tracker) return "No tracker repository";
    const [later, next, ...rest] = roadmapColumns(roadmap.data);
    return [
      next ? `${next.title}: ${next.items.length}` : "No versions yet",
      ...rest.map((column) => `${column.title}: ${column.items.length}`),
      `Later: ${later?.items.length ?? 0}`,
    ].join(" · ");
  }, [roadmap.data]);
  return <SummaryLine title="Roadmap" text={text} onOpen={onOpen} />;
}

/** Issue counts per lane on the Dashboard, linking to the Issues tab. */
export function ProjectIssuesSummary({
  summary,
  onOpen,
}: {
  readonly summary: OrchestratorSummary;
  readonly onOpen: () => void;
}) {
  const query = useEnvironmentQuery(
    projectIssuesQuery({
      environmentId: summary.root.environmentId,
      input: { rootThreadId: summary.root.id },
    }),
  );
  const text = useMemo(() => {
    if (!query.data) return "Loading";
    const { lanes, backlog } = groupProjectIssues(query.data.issues);
    return [
      ...PROJECT_ISSUE_LANES.map((lane) => `${lane.title}: ${lanes[lane.status].length}`),
      `Backlog: ${backlog.length}`,
    ].join(" · ");
  }, [query.data]);
  return <SummaryLine title="Issues" text={text} onOpen={onOpen} />;
}
