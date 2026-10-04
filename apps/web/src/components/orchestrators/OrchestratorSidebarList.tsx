import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildOrchestratorSummaries,
  buildStandaloneThreadGroups,
  type OrchestratorSummary,
  type StandaloneThreadStatus,
} from "@t3tools/client-runtime/state/orchestrators";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, UsersIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { ThreadIssueBadges } from "../ThreadIssueBadges";
import { ProjectFavicon } from "../ProjectFavicon";
import { OrchestratorStatus } from "./OrchestratorStatus";

const QUIET_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const STANDALONE_STATUS: Record<
  StandaloneThreadStatus,
  { readonly label: string; readonly className: string }
> = {
  approval: { label: "Needs approval", className: "bg-warning" },
  input: { label: "Needs input", className: "bg-warning" },
  plan: { label: "Plan ready", className: "bg-primary" },
  working: { label: "Working", className: "bg-info" },
  completed: { label: "Completed", className: "bg-success" },
};

function ProjectRow({ summary }: { readonly summary: OrchestratorSummary }) {
  const navigate = useNavigate();
  const rootRef = scopeThreadRef(summary.root.environmentId, summary.root.id);
  const rootProject =
    summary.projects.find(
      (project) =>
        project.environmentId === summary.root.environmentId &&
        project.id === summary.root.projectId,
    ) ?? summary.projects[0];
  return (
    <li className="relative rounded-md hover:bg-sidebar-row-hover">
      <button
        type="button"
        aria-label={`Open ${summary.root.title} project`}
        className="absolute inset-0 z-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() =>
          void navigate({
            to: "/orchestrators/$environmentId/$threadId",
            params: { environmentId: rootRef.environmentId, threadId: rootRef.threadId },
          })
        }
      />
      <div className="pointer-events-none relative z-10 flex w-full flex-col gap-1.5 px-2.5 py-2 text-left">
        <span className="flex min-w-0 w-full items-center gap-2">
          {rootProject ? <ProjectFavicon project={rootProject} className="size-4" /> : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
            {summary.root.title}
          </span>
          <span className="pointer-events-auto flex items-center gap-1">
            <ThreadIssueBadges issues={summary.issues} />
          </span>
        </span>
        <span className="flex min-w-0 w-full items-center gap-2 text-xs">
          <OrchestratorStatus status={summary.status} />
          <span className="ml-auto inline-flex items-center gap-2 text-sidebar-muted-foreground">
            {summary.needsYou.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-warning-foreground">
                <CircleAlertIcon className="size-3.5" />
                {summary.needsYou.length}
              </span>
            ) : null}
            {summary.activeWorkerCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                <UsersIcon className="size-3.5" />
                {summary.activeWorkerCount} working
              </span>
            ) : null}
            <span>{formatRelativeTimeLabel(summary.latestActivityAt)}</span>
          </span>
        </span>
        <span className="truncate text-3xs text-sidebar-muted-foreground">
          {summary.projects.map((project) => project.title).join(" · ")}
        </span>
      </div>
    </li>
  );
}

export function OrchestratorSidebarList() {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [quietExpanded, setQuietExpanded] = useState(false);
  const [quietCutoff] = useState(() => Date.now() - QUIET_AFTER_MS);
  const summaries = useMemo(
    () => buildOrchestratorSummaries(threads, projects),
    [projects, threads],
  );
  const standaloneGroups = useMemo(
    () => buildStandaloneThreadGroups(threads, projects, lastVisitedAtByThreadKey),
    [lastVisitedAtByThreadKey, projects, threads],
  );
  const active = summaries.filter(
    (summary) =>
      summary.needsYou.length > 0 ||
      summary.activeWorkerCount > 0 ||
      Date.parse(summary.latestActivityAt) >= quietCutoff,
  );
  const quiet = summaries.filter((summary) => !active.includes(summary));

  return (
    <div className="flex flex-col gap-3">
      {summaries.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-sidebar-muted-foreground">
          Projects appear when a top-level thread has workers.
        </p>
      ) : (
        <>
          <ul aria-label="Projects" className="flex flex-col gap-px">
            {active.map((summary) => (
              <ProjectRow
                key={`${summary.root.environmentId}:${summary.root.id}`}
                summary={summary}
              />
            ))}
          </ul>
          {quiet.length > 0 ? (
            <div>
              <button
                type="button"
                className="flex h-7 w-full cursor-pointer items-center gap-1 px-2.5 text-xs font-medium text-sidebar-muted-foreground hover:text-sidebar-foreground"
                onClick={() => setQuietExpanded((value) => !value)}
              >
                {quietExpanded ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
                Quiet
                <span className="tabular-nums">{quiet.length}</span>
              </button>
              {quietExpanded ? (
                <ul aria-label="Quiet projects" className="flex flex-col gap-px">
                  {quiet.map((summary) => (
                    <ProjectRow
                      key={`${summary.root.environmentId}:${summary.root.id}`}
                      summary={summary}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {standaloneGroups.length > 0 ? (
        <section aria-label="Standalone threads">
          <h2 className="px-2.5 py-1 text-xs font-semibold tracking-wide text-sidebar-muted-foreground uppercase">
            Threads
          </h2>
          {standaloneGroups.map((group) => (
            <div key={`${group.project.environmentId}:${group.project.id}`}>
              <h3 className="px-3 py-1 text-3xs font-medium text-sidebar-muted-foreground">
                {group.project.title}
              </h3>
              <ul className="flex flex-col gap-px">
                {group.threads.map(({ thread, status }) => {
                  const presentation = STANDALONE_STATUS[status];
                  return (
                    <li key={`${thread.environmentId}:${thread.id}`}>
                      <button
                        type="button"
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-4 text-left text-xs hover:bg-sidebar-row-hover"
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(thread.environmentId, thread.id),
                            ),
                          })
                        }
                      >
                        <span
                          aria-hidden
                          className={`size-1.5 shrink-0 rounded-full ${presentation.className}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                          {thread.title}
                        </span>
                        <span className="shrink-0 text-3xs text-sidebar-muted-foreground">
                          {presentation.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
