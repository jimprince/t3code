import {
  buildOrchestratorSummaries,
  orchestratorDoneSince,
  type OrchestratorSummary,
} from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, CircleAlertIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useProjects, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadIssueBadges } from "../ThreadIssueBadges";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button, InlineButton } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { OrchestratorStatus } from "./OrchestratorStatus";
import { readOrchestratorLastVisit, recordOrchestratorVisit } from "./orchestratorVisit";

function BoardSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        <span className="tabular-nums text-foreground/60">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function OpenThreadButton({
  summary,
  threadId,
}: {
  readonly summary: OrchestratorSummary;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(summary.root.environmentId, threadId)),
        })
      }
    >
      Open thread
      <ArrowUpRightIcon />
    </Button>
  );
}

const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="py-2 text-sm text-muted-foreground">{children}</p>
);

export function OrchestratorBoard({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const summary = useMemo(
    () =>
      buildOrchestratorSummaries(threads, projects).find(
        (item) => item.root.environmentId === environmentId && item.root.id === threadId,
      ) ?? null,
    [environmentId, projects, threadId, threads],
  );
  const previousVisit = useMemo(
    () =>
      readOrchestratorLastVisit(
        typeof window === "undefined" ? undefined : window.localStorage,
        environmentId,
        threadId,
      ),
    [environmentId, threadId],
  );
  const done = useMemo(
    () => (summary === null ? [] : orchestratorDoneSince(summary, previousVisit)),
    [previousVisit, summary],
  );

  useEffect(() => {
    recordOrchestratorVisit(window.localStorage, environmentId, threadId, new Date().toISOString());
  }, [environmentId, threadId]);

  if (summary === null) {
    return (
      <SidebarInset className="h-dvh">
        <WorkspacePageContainer>
          <Empty>This orchestrator is no longer available.</Empty>
        </WorkspacePageContainer>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <WorkspaceBreadcrumb ariaLabel="Orchestrator breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>{summary.root.title}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(summary.root.environmentId, summary.root.id),
                ),
              })
            }
          >
            Open orchestrator
            <ArrowUpRightIcon />
          </Button>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide" className="gap-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <OrchestratorStatus status={summary.status} />
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <UsersIcon className="size-4" />
                {summary.activeWorkerCount} active
              </span>
              {summary.needsYou.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-warning-foreground">
                  <CircleAlertIcon className="size-4" />
                  {summary.needsYou.length} need you
                </span>
              ) : null}
              <span className="flex flex-wrap gap-1">
                {summary.projects.map((project) => (
                  <span
                    key={`${project.environmentId}:${project.id}`}
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {project.title}
                  </span>
                ))}
              </span>
            </div>

            <BoardSection title="Needs you" count={summary.needsYou.length}>
              {summary.needsYou.length === 0 ? (
                <Empty>Nothing is waiting on you.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {summary.needsYou.map((item) => (
                    <li
                      key={`${item.kind}:${item.thread.id}`}
                      className="flex items-center gap-3 py-2"
                    >
                      <CircleAlertIcon className="size-4 shrink-0 text-warning-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{item.thread.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.kind === "approval" ? "Approval" : "Question"}
                      </span>
                      <OpenThreadButton summary={summary} threadId={item.thread.id} />
                    </li>
                  ))}
                </ul>
              )}
            </BoardSection>

            <BoardSection title="Working" count={summary.working.length}>
              {summary.working.length === 0 ? (
                <Empty>No workers are active.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {summary.working.map((item) => (
                    <li key={item.thread.id} className="flex items-start gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {item.thread.title}
                        </span>
                        {item.latestLine ? (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {item.latestLine}
                          </span>
                        ) : null}
                      </span>
                      <OpenThreadButton summary={summary} threadId={item.thread.id} />
                    </li>
                  ))}
                </ul>
              )}
            </BoardSection>

            <BoardSection title="Done since your last visit" count={done.length}>
              {done.length === 0 ? (
                <Empty>No newly completed workers.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {done.map((item) => (
                    <li key={item.thread.id} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm">{item.thread.title}</span>
                      <time className="text-xs text-muted-foreground" dateTime={item.completedAt}>
                        {new Date(item.completedAt).toLocaleString()}
                      </time>
                      <OpenThreadButton summary={summary} threadId={item.thread.id} />
                    </li>
                  ))}
                </ul>
              )}
            </BoardSection>

            <BoardSection
              title="Issues & PRs"
              count={summary.issues.length + summary.pullRequests.length}
            >
              {summary.issues.length + summary.pullRequests.length === 0 ? (
                <Empty>No linked issues or pull requests.</Empty>
              ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                  <ThreadIssueBadges issues={summary.issues} />
                  {summary.pullRequests.map((pullRequest) => (
                    <InlineButton
                      key={`${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`}
                      render={
                        <a href={pullRequest.url} target="_blank" rel="noopener noreferrer" />
                      }
                    >
                      <PullRequestGlyph.pullRequest className="size-3.5" />
                      {pullRequest.repository} #{pullRequest.number}
                    </InlineButton>
                  ))}
                </div>
              )}
            </BoardSection>
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
