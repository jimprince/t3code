import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  formatIssueAge,
  groupProjectIssues,
  PROJECT_ISSUE_LANES,
  type ProjectIssueLane,
} from "./projectIssuesBoard.logic";
import { ProjectQueryState } from "./ProjectQueryState";
import { issueKey, taskKind } from "./projectRequests.logic";
import {
  ReopenButton,
  SettleButton,
  useOpenThread,
  useSettle,
  useTaskStatuses,
  type SettleControls,
} from "./ProjectRequestsSection";
import { TaskTitle } from "./TaskLink";

const DONE_PREVIEW = 8;
const PENDING_PREVIEW = 10;

function IssueRow({
  issue,
  now,
  settle,
  onOpenThread,
}: {
  readonly issue: ProjectIssue;
  readonly now: number;
  readonly settle: SettleControls;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const thread = issue.requestSource?.threadId ?? issue.linkedThreadIds[0];
  const closed = issue.closedAt !== null || issue.status === "done";
  return (
    <li className="border-b border-border/60 py-1.5 last:border-b-0">
      <TaskTitle
        task={{ host: issue.host, repository: issue.repository, number: issue.number }}
        url={issue.url}
        className="line-clamp-2 max-w-full text-sm text-foreground hover:underline"
      >
        {issue.title}
      </TaskTitle>
      {issue.labels.some((label) => label.toLowerCase() === "needs-test") ? (
        <span className="block text-xs text-foreground/80">
          Shipped{issue.milestone ? ` in ${issue.milestone.title}` : ""}, test it
        </span>
      ) : null}
      {/* The same tags, in the same order, on every card; nothing is clipped. */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="break-all">
          {issue.repository.split("/")[1]}#{issue.number}
        </span>
        <span className="text-foreground/70">
          {taskKind(issue.labels) ?? (issue.isRequest ? "request" : "issue")}
        </span>
        {issue.comments > 0 ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <MessageSquareIcon className="size-3" />
            {issue.comments}
          </span>
        ) : null}
        <span className="tabular-nums">
          {formatIssueAge(issue.closedAt ?? issue.updatedAt, now)}
        </span>
        {thread ? (
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() => onOpenThread(thread)}
          >
            thread
          </button>
        ) : null}
        <span className="ml-auto">
          {closed ? (
            <ReopenButton issue={issue} settle={settle} />
          ) : (
            <SettleButton issues={[issue]} settle={settle} />
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * The project's tasks (its Gitea issues, requests included) as a board in the
 * four statuses: For review (the Dashboard's Needs you), Active, Pending and
 * Complete, for every repository the orchestrator tree works in. Every card
 * can be settled or reopened in place.
 */
export function ProjectIssuesBoard({
  summary,
  pendingPreview = PENDING_PREVIEW,
}: {
  readonly summary: OrchestratorSummary;
  /** Pending cards shown before "Show all" (the layout's setting). */
  readonly pendingPreview?: number;
}) {
  const { statuses, query } = useTaskStatuses(summary);
  const settle = useSettle(summary, query.refresh);
  const openThread = useOpenThread(summary);
  const [showBacklog, setShowBacklog] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<ProjectIssueLane>>(new Set());
  const grouped = useMemo(
    () => groupProjectIssues(query.data?.issues ?? [], statuses),
    [query.data, statuses],
  );
  const now = query.dataUpdatedAt ?? 0;
  const failed = (query.data?.repositories ?? []).filter((repository) => repository.error);

  if (query.data === null) {
    return <ProjectQueryState what="tasks" error={query.error} onRetry={query.refresh} />;
  }
  if (query.data.repositories.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">No Gitea repository for this project.</p>
    );
  }

  const row = (issue: ProjectIssue) => (
    <IssueRow
      key={issueKey(issue)}
      issue={issue}
      now={now}
      settle={settle}
      onOpenThread={openThread}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-px overflow-hidden border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {PROJECT_ISSUE_LANES.map(({ lane, title }) => {
          const all = grouped.lanes[lane];
          const preview =
            lane === "complete" ? DONE_PREVIEW : lane === "pending" ? pendingPreview : 0;
          const folded = preview > 0 && !expanded.has(lane) && all.length > preview;
          return (
            <section key={lane} className="min-w-0 bg-background px-2.5 py-2">
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {title}
                <span className="tabular-nums text-foreground/60">{all.length}</span>
              </h3>
              <ul>{(folded ? all.slice(0, preview) : all).map(row)}</ul>
              {preview > 0 && all.length > preview ? (
                <button
                  type="button"
                  className="mt-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(lane)) next.delete(lane);
                      else next.add(lane);
                      return next;
                    })
                  }
                >
                  {folded ? `Show all ${all.length}` : "Show fewer"}
                </button>
              ) : null}
              {lane === "pending" && grouped.backlog.length > 0 ? (
                <div className="mt-1">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowBacklog((value) => !value)}
                  >
                    Backlog {grouped.backlog.length}
                  </button>
                  {showBacklog ? <ul>{grouped.backlog.map(row)}</ul> : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {query.data.repositories.map((repository) => repository.repository).join(", ")}
        {failed.length > 0
          ? ` · could not read ${failed.map((repository) => repository.repository).join(", ")}`
          : ""}
      </p>
    </div>
  );
}
