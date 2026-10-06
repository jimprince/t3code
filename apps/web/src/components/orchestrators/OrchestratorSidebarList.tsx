import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildOrchestratorSummaries,
  buildStandaloneThreadGroups,
  projectSidebarBucket,
  sortOrchestratorSummariesForSidebar,
  type OrchestratorSummary,
  type ProjectSidebarBucket,
  type StandaloneThreadStatus,
} from "@t3tools/client-runtime/state/orchestrators";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, UsersIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { OrchestratorStatus } from "./OrchestratorStatus";
import { useDeferredProjectSidebarBuckets } from "./projectSidebarOrder";
import { useOrchestratorThreadShells } from "./useOrchestratorThreads";

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
const STANDALONE_BUCKET: Record<StandaloneThreadStatus, ProjectSidebarBucket> = {
  approval: "needs-you",
  input: "needs-you",
  plan: "needs-you",
  working: "working",
  completed: "idle",
};
const BUCKET_RANK: Record<ProjectSidebarBucket, number> = {
  "needs-you": 0,
  working: 1,
  idle: 2,
  quiet: 3,
};
const threadKey = (thread: { readonly environmentId: string; readonly id: string }) =>
  `${thread.environmentId}:${thread.id}`;

/**
 * The project whose page or thread is open: its orchestrator, or any thread in
 * its tree, matches the route's environment and thread.
 */
function useSelectedRoute() {
  return useParams({
    strict: false,
    select: (params: { environmentId?: string; threadId?: string }) =>
      params.environmentId && params.threadId ? `${params.environmentId}:${params.threadId}` : null,
  });
}

const containsThread = (summary: OrchestratorSummary, key: string | null) =>
  key !== null &&
  [summary.root, ...summary.descendants].some((thread) => threadKey(thread) === key);

function ProjectRow({
  summary,
  selected,
}: {
  readonly summary: OrchestratorSummary;
  readonly selected: boolean;
}) {
  const navigate = useNavigate();
  const openIssues = summary.issues.filter((issue) => issue.snapshot?.state !== "closed").length;
  const rootRef = scopeThreadRef(summary.root.environmentId, summary.root.id);
  const rootProject =
    summary.projects.find(
      (project) =>
        project.environmentId === summary.root.environmentId &&
        project.id === summary.root.projectId,
    ) ?? summary.projects[0];
  return (
    <li
      className={`relative rounded-md ${
        selected ? "bg-sidebar-row-active text-sidebar-foreground" : "hover:bg-sidebar-row-hover"
      }`}
    >
      <button
        type="button"
        aria-label={`Open ${summary.root.title} project`}
        aria-current={selected ? "page" : undefined}
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
          {openIssues > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
              {openIssues} {openIssues === 1 ? "issue" : "issues"}
            </span>
          ) : null}
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
  const threads = useOrchestratorThreadShells();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const selectedRoute = useSelectedRoute();
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
  const desiredBuckets = useMemo(
    () => [
      ...summaries.map(
        (summary) => [threadKey(summary.root), projectSidebarBucket(summary, quietCutoff)] as const,
      ),
      ...standaloneGroups.flatMap((group) =>
        group.threads.map(
          ({ thread, status }) => [threadKey(thread), STANDALONE_BUCKET[status]] as const,
        ),
      ),
    ],
    [quietCutoff, standaloneGroups, summaries],
  );
  const displayedBuckets = useDeferredProjectSidebarBuckets(desiredBuckets);
  const orderedSummaries = useMemo(
    () => sortOrchestratorSummariesForSidebar(summaries, quietCutoff, displayedBuckets),
    [displayedBuckets, quietCutoff, summaries],
  );
  const active = orderedSummaries.filter(
    (summary) => displayedBuckets.get(threadKey(summary.root)) !== "quiet",
  );
  const quiet = orderedSummaries.filter(
    (summary) => displayedBuckets.get(threadKey(summary.root)) === "quiet",
  );
  const orderedStandaloneGroups = useMemo(
    () =>
      standaloneGroups
        .map((group) => ({
          ...group,
          threads: [...group.threads].sort(
            (left, right) =>
              BUCKET_RANK[
                displayedBuckets.get(threadKey(left.thread)) ?? STANDALONE_BUCKET[left.status]
              ] -
                BUCKET_RANK[
                  displayedBuckets.get(threadKey(right.thread)) ?? STANDALONE_BUCKET[right.status]
                ] || left.thread.title.localeCompare(right.thread.title),
          ),
        }))
        .sort((left, right) => left.project.title.localeCompare(right.project.title)),
    [displayedBuckets, standaloneGroups],
  );

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
                selected={containsThread(summary, selectedRoute)}
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
                      selected={containsThread(summary, selectedRoute)}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {orderedStandaloneGroups.length > 0 ? (
        <section aria-label="Standalone threads">
          <h2 className="px-2.5 py-1 text-xs font-semibold tracking-wide text-sidebar-muted-foreground uppercase">
            Threads
          </h2>
          {orderedStandaloneGroups.map((group) => (
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
                          {thread.remoteParent && (
                            <span className="text-sidebar-muted-foreground">
                              {" "}
                              · parent on{" "}
                              {environments.find(
                                (environment) =>
                                  environment.environmentId === thread.remoteParent?.environmentId,
                              )?.label ?? thread.remoteParent.environmentId}
                            </span>
                          )}
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
