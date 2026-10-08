import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { InlineButton } from "../ui/button";

import {
  formatIssueAge,
  groupProjectIssues,
  PROJECT_ISSUE_LANES,
  type ProjectIssueLane,
} from "./projectIssuesBoard.logic";
import { ProjectQueryState } from "./ProjectQueryState";
import { isBug, issueKey, taskKind } from "./projectRequests.logic";
import { RequestKindTag } from "./RequestKindTag";
import { RowMenu } from "./ProjectSection";
import {
  SettleButton,
  useSettle,
  useTaskStatuses,
  type SettleControls,
} from "./ProjectRequestsSection";
import { taskStepProgress } from "./taskProgress.logic";
import { TaskTitle } from "./TaskLink";

const DONE_PREVIEW = 8;
const PENDING_PREVIEW = 10;

/**
 * A card: the title (never cut), the type and age, and what Brad can do. For
 * review cards offer Settle; the rest keep Settle or Reopen in their menu. The
 * lane is its status.
 */
function IssueRow({
  issue,
  lane,
  now,
  settle,
  steps,
}: {
  readonly issue: ProjectIssue;
  readonly lane: ProjectIssueLane;
  readonly now: number;
  readonly settle: SettleControls;
  /** "3 of 5 steps" from the working thread's to-do list, or null. */
  readonly steps: string | null;
}) {
  const closed = issue.closedAt !== null || issue.status === "done";
  return (
    <li className="border-b border-border/60 py-1.5 last:border-b-0">
      <TaskTitle
        task={{ host: issue.host, repository: issue.repository, number: issue.number }}
        url={issue.url}
        className="max-w-full text-sm text-foreground hover:underline"
      >
        {issue.title}
      </TaskTitle>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <RequestKindTag kind={taskKind(issue.labels)} bug={isBug(issue.labels)} />
        {issue.labels.some((label) => label.toLowerCase() === "needs-test") && issue.milestone ? (
          <span>{issue.milestone.title}</span>
        ) : null}
        <span className="tabular-nums">
          {formatIssueAge(issue.closedAt ?? issue.updatedAt, now)}
        </span>
        {steps ? <span className="tabular-nums">{steps}</span> : null}
        <span className="ml-auto">
          {lane === "for-review" ? (
            <SettleButton issues={[issue]} settle={settle} />
          ) : (
            <RowMenu
              label={issue.title}
              items={[
                closed
                  ? {
                      label: "Reopen",
                      disabled: settle.isBusy(issue),
                      onClick: () => void settle.reopen(issue),
                    }
                  : {
                      label: "Settle",
                      disabled: settle.isBusy(issue),
                      onClick: () => void settle.settle([issue]),
                    },
              ]}
            />
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
  const [showBacklog, setShowBacklog] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<ProjectIssueLane>>(new Set());
  const grouped = useMemo(
    () => groupProjectIssues(query.data?.issues ?? [], statuses),
    [query.data, statuses],
  );
  const now = query.dataUpdatedAt ?? 0;
  const threadsById = useMemo(
    () => new Map([summary.root, ...summary.descendants].map((thread) => [thread.id, thread])),
    [summary.descendants, summary.root],
  );
  const failed = (query.data?.repositories ?? []).filter((repository) => repository.error);

  if (query.data === null) {
    return <ProjectQueryState what="tasks" error={query.error} onRetry={query.refresh} />;
  }
  if (query.data.repositories.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No task repository yet. Set one under Edit.
      </p>
    );
  }

  const row = (lane: ProjectIssueLane) => (issue: ProjectIssue) => (
    <IssueRow
      key={issueKey(issue)}
      issue={issue}
      lane={lane}
      now={now}
      settle={settle}
      steps={lane === "active" ? taskStepProgress(issue, threadsById) : null}
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
              <ul>{(folded ? all.slice(0, preview) : all).map(row(lane))}</ul>
              {preview > 0 && all.length > preview ? (
                <p className="mt-1 text-xs">
                  <InlineButton
                    tone="muted"
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
                  </InlineButton>
                </p>
              ) : null}
              {lane === "pending" && grouped.backlog.length > 0 ? (
                <div className="mt-1">
                  <p className="text-xs">
                    <InlineButton
                      tone="muted"
                      aria-expanded={showBacklog}
                      onClick={() => setShowBacklog((value) => !value)}
                    >
                      Later {grouped.backlog.length}
                    </InlineButton>
                  </p>
                  {showBacklog ? <ul>{grouped.backlog.map(row("pending"))}</ul> : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {failed.length > 0 ? (
        <p role="alert" className="text-xs text-warning-foreground">
          Could not read {failed.map((repository) => repository.repository).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
