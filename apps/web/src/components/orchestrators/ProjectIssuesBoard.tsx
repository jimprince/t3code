import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectIssue } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { resolveThreadIssueBadgeTarget } from "../ThreadIssueBadges";
import { useEmbeddedPages } from "../embeddedPages/useEmbeddedPages";
import { projectIssuesQuery } from "../../state/projectIssues";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  formatIssueAge,
  groupProjectIssues,
  PROJECT_ISSUE_LANES,
  type ProjectIssueLaneStatus,
} from "./projectIssuesBoard.logic";
import { projectReturnState, type ProjectReturnLocation } from "./projectNavigation";

const DONE_PREVIEW = 8;

function IssueRow({
  environmentId,
  issue,
  now,
  projectReturn,
}: {
  readonly environmentId: EnvironmentId;
  readonly issue: ProjectIssue;
  readonly now: number;
  readonly projectReturn: ProjectReturnLocation;
}) {
  const navigate = useNavigate();
  const pages = useEmbeddedPages();
  const target = resolveThreadIssueBadgeTarget(pages, issue);
  const thread = issue.requestSource?.threadId ?? issue.linkedThreadIds[0];
  return (
    <li className="border-b border-border/60 py-1.5 last:border-b-0">
      {target.kind === "external" ? (
        <a
          href={target.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-sm text-foreground hover:underline"
        >
          {issue.title}
        </a>
      ) : (
        <button
          type="button"
          className="block max-w-full truncate text-sm text-foreground hover:underline"
          onClick={() =>
            void navigate({
              to: "/embedded/$pageId",
              params: { pageId: target.pageId },
              search: { repo: target.repo, issue: target.issue },
              state: projectReturnState(projectReturn),
            })
          }
        >
          {issue.title}
        </button>
      )}
      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {issue.repository.split("/")[1]}#{issue.number}
        </span>
        {issue.isRequest ? <span className="text-foreground/70">request</span> : null}
        {issue.comments > 0 ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <MessageSquareIcon className="size-3" />
            {issue.comments}
          </span>
        ) : null}
        <span className="ml-auto tabular-nums">
          {formatIssueAge(issue.closedAt ?? issue.updatedAt, now)}
        </span>
        {thread ? (
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, thread)),
                state: projectReturnState(projectReturn),
              })
            }
          >
            thread
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The project's Gitea issues as a board, in the Agent Status Board's lanes:
 * every repository the orchestrator tree works in, requests included.
 */
export function ProjectIssuesBoard({ summary }: { readonly summary: OrchestratorSummary }) {
  const query = useEnvironmentQuery(
    projectIssuesQuery({
      environmentId: summary.root.environmentId,
      input: { rootThreadId: summary.root.id },
    }),
  );
  const [showBacklog, setShowBacklog] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const grouped = useMemo(() => groupProjectIssues(query.data?.issues ?? []), [query.data]);
  const now = query.dataUpdatedAt ?? 0;
  const failed = (query.data?.repositories ?? []).filter((repository) => repository.error);

  if (query.data === null) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        {query.error ? `Issues unavailable: ${query.error}` : "Loading issues..."}
      </p>
    );
  }
  if (query.data.repositories.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">No Gitea repository for this project.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-px overflow-hidden border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {PROJECT_ISSUE_LANES.map((lane) => {
          const status: ProjectIssueLaneStatus = lane.status;
          const all = grouped.lanes[status];
          const items = status === "done" && !showAllDone ? all.slice(0, DONE_PREVIEW) : all;
          return (
            <section key={status} className="min-w-0 bg-background px-2.5 py-2">
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {lane.title}
                <span className="tabular-nums text-foreground/60">{all.length}</span>
              </h3>
              <ul>
                {items.map((issue) => (
                  <IssueRow
                    key={`${issue.repository}#${issue.number}`}
                    environmentId={summary.root.environmentId}
                    issue={issue}
                    now={now}
                    projectReturn={{
                      environmentId: summary.root.environmentId,
                      threadId: summary.root.id,
                    }}
                  />
                ))}
              </ul>
              {status === "done" && all.length > DONE_PREVIEW ? (
                <button
                  type="button"
                  className="mt-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAllDone((value) => !value)}
                >
                  {showAllDone ? "Show fewer" : `Show all ${all.length}`}
                </button>
              ) : null}
              {status === "pending" && grouped.backlog.length > 0 ? (
                <div className="mt-1">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowBacklog((value) => !value)}
                  >
                    Backlog {grouped.backlog.length}
                  </button>
                  {showBacklog ? (
                    <ul>
                      {grouped.backlog.map((issue) => (
                        <IssueRow
                          key={`${issue.repository}#${issue.number}`}
                          environmentId={summary.root.environmentId}
                          issue={issue}
                          now={now}
                          projectReturn={{
                            environmentId: summary.root.environmentId,
                            threadId: summary.root.id,
                          }}
                        />
                      ))}
                    </ul>
                  ) : null}
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
