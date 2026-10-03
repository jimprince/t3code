import { buildOrchestratorSummaries } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, UsersIcon } from "lucide-react";
import { useMemo } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { ThreadIssueBadges } from "../ThreadIssueBadges";
import { OrchestratorStatus } from "./OrchestratorStatus";

export function OrchestratorSidebarList() {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const summaries = useMemo(
    () => buildOrchestratorSummaries(threads, projects),
    [projects, threads],
  );

  if (summaries.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-xs text-sidebar-muted-foreground">
        Orchestrators appear when a top-level thread has workers.
      </p>
    );
  }

  return (
    <ul aria-label="Orchestrators" className="flex flex-col gap-px">
      {summaries.map((summary) => {
        const rootRef = scopeThreadRef(summary.root.environmentId, summary.root.id);
        return (
          <li
            key={`${summary.root.environmentId}:${summary.root.id}`}
            className="relative rounded-md hover:bg-sidebar-row-hover"
          >
            <button
              type="button"
              aria-label={`Open ${summary.root.title} orchestrator board`}
              className="absolute inset-0 z-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() =>
                void navigate({
                  to: "/orchestrators/$environmentId/$threadId",
                  params: { environmentId: rootRef.environmentId, threadId: rootRef.threadId },
                })
              }
            />
            <div className="pointer-events-none relative z-10 flex w-full flex-col gap-2 px-2.5 py-2.5 text-left">
              <span className="flex min-w-0 w-full items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
                  {summary.root.title}
                </span>
                <span className="pointer-events-auto flex items-center gap-1">
                  <ThreadIssueBadges issues={summary.issues} />
                </span>
              </span>
              <span className="flex min-w-0 w-full items-center gap-2 text-xs">
                <OrchestratorStatus status={summary.status} />
                <span className="ml-auto inline-flex items-center gap-1 text-sidebar-muted-foreground">
                  {summary.needsYou.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-warning-foreground">
                      <CircleAlertIcon className="size-3.5" />
                      {summary.needsYou.length}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1">
                    <UsersIcon className="size-3.5" />
                    {summary.activeWorkerCount}
                  </span>
                </span>
              </span>
              {summary.projects.length > 0 ? (
                <span className="flex min-w-0 w-full flex-wrap gap-1">
                  {summary.projects.map((project) => (
                    <span
                      key={`${project.environmentId}:${project.id}`}
                      className="max-w-32 truncate rounded-sm bg-accent px-1.5 py-0.5 text-3xs text-sidebar-muted-foreground"
                    >
                      {project.title}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
