import {
  buildOrchestratorSummaries,
  type OrchestratorSummary,
} from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  applyLayoutOps,
  CommandId,
  type EnvironmentId,
  type ProjectLayoutOp,
  type ProjectLayoutTab,
  type ProjectLayoutWidget,
  type ThreadId,
  withoutRetiredWidgets,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useProjects, useServerConfigs } from "../../state/entities";
import { updateProjectScopeCommand } from "../../state/forkProjectScope";
import { setThreadSubprojectCommand } from "../../state/forkSubproject";
import { useSupervisionReadyHosts } from "../../state/forkSupervision";
import { threadEnvironment } from "../../state/threads";
import { applyProjectLayout, useProjectLayout } from "../../state/projectLayout";
import { projectDashboardQuery, setProjectDashboardTracker } from "../../state/projectDashboard";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatView from "../ChatView";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { OrchestratorStatus } from "./OrchestratorStatus";
import { useOrchestratorThreadShells } from "./useOrchestratorThreads";
import { readOrchestratorLastVisit, recordOrchestratorVisit } from "./orchestratorVisit";
import { ProjectAutomationsSlot } from "../projects/ProjectAutomationsSlot";
import { ProjectDecisionFeed, useDecisionFeedCount } from "./ProjectDecisionFeed";
import { ProjectIssuesBoard } from "./ProjectIssuesBoard";
import { ProjectTaskPanel } from "./ProjectTaskPanel";
import { OpenTaskContext } from "./TaskLink";
import { TeamStrip, useWorkstreamBands, WorkstreamBands } from "./WorkstreamBands";
import type { TaskRef } from "./taskView.logic";
import {
  ClickableRow,
  ProjectMaintenanceWidget,
  ProjectReleaseLine,
  ProjectReleaseWidget,
  ProjectRequestsSection,
  useTaskStatuses,
} from "./ProjectRequestsSection";
import { ProjectLayoutTabView, TAB_DRAG_TYPE, WIDGET_DRAG_TYPE } from "./ProjectLayoutView";
import { ProjectRoadmapWidget, SaveForLater } from "./ProjectRoadmapWidget";
import { ProjectPullRequestsWidget } from "./ProjectPullRequestsWidget";
import { ProjectRequestBox } from "./ProjectRequestBox";
import { ProjectSection } from "./ProjectSection";
import { ProjectIssuesSummary, ProjectRoadmapSummary } from "./ProjectTabSummaries";
import { resolveProjectTab, type ProjectTab } from "./projectTabs.logic";
import { HEALTH_LABEL, isHealthStale, latestWorkChangeAt } from "./projectHealth.logic";
import { deriveBlocked, type BlockedRow } from "./projectWork.logic";
import { projectReturnState } from "./projectNavigation";
import {
  projectTrail,
  subprojectBlocked,
  subprojectIsActive,
  subprojectNeedsYou,
  taskProgressLabel,
} from "./projectSubprojects.logic";

/**
 * The layout's tabs, with the page's actions (Edit layout) at the right. In edit
 * mode tabs can be dragged, renamed (double-click), removed and added, and a
 * widget dropped on a tab moves to its end.
 */
function ProjectTabBar({
  tabs,
  tab,
  onSelect,
  actions,
  editing,
  onApply,
}: {
  readonly tabs: ReadonlyArray<ProjectLayoutTab>;
  readonly tab: ProjectTab;
  readonly onSelect: (tab: ProjectTab) => void;
  readonly actions?: ReactNode;
  readonly editing: boolean;
  readonly onApply: (ops: ProjectLayoutOp[]) => void;
}) {
  const [newTab, setNewTab] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div className="flex items-end gap-4 border-b border-border">
      <div role="tablist" aria-label="Project views" className="flex flex-wrap gap-4">
        {tabs.map((item, index) => (
          <div
            key={item.id}
            className="flex items-center gap-1"
            draggable={editing}
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_DRAG_TYPE, item.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              const types = event.dataTransfer.types;
              if (editing && (types.includes(TAB_DRAG_TYPE) || types.includes(WIDGET_DRAG_TYPE))) {
                event.preventDefault();
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const movedTab = event.dataTransfer.getData(TAB_DRAG_TYPE);
              const movedWidget = event.dataTransfer.getData(WIDGET_DRAG_TYPE);
              if (movedTab && movedTab !== item.id) {
                onApply([{ op: "moveTab", tabId: movedTab, index }]);
              } else if (movedWidget) {
                onApply([
                  {
                    op: "moveWidget",
                    widgetId: movedWidget,
                    tabId: item.id,
                    index: item.widgets.length,
                  },
                ]);
              }
            }}
          >
            {editing && renaming === item.id ? (
              <Input
                aria-label={`Rename ${item.title}`}
                className="-mb-px h-7 w-32"
                defaultValue={item.title}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(null);
                }}
                onBlur={(event) => {
                  setRenaming(null);
                  const title = event.target.value.trim();
                  if (title && title !== item.title) {
                    onApply([{ op: "renameTab", tabId: item.id, title }]);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={`-mb-px border-b-2 px-0.5 pb-2 text-sm ${
                  tab === item.id
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                } ${editing ? "cursor-grab" : ""}`}
                onClick={() => onSelect(item.id)}
                onDoubleClick={() => editing && setRenaming(item.id)}
              >
                {item.title}
              </button>
            )}
            {editing && tabs.length > 1 ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove the ${item.title} tab`}
                onClick={() => onApply([{ op: "removeTab", tabId: item.id }])}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        ))}
        {editing ? (
          <form
            className="flex items-center gap-1 pb-1"
            onSubmit={(event) => {
              event.preventDefault();
              const title = newTab.trim();
              if (!title) return;
              onApply([{ op: "addTab", tab: { title } }]);
              setNewTab("");
            }}
          >
            <Input
              aria-label="New tab"
              className="h-7 w-28"
              placeholder="New tab"
              value={newTab}
              onChange={(event) => setNewTab(event.target.value)}
            />
            <Button size="icon-xs" variant="ghost" type="submit" aria-label="Add tab">
              <PlusIcon />
            </Button>
          </form>
        ) : null}
      </div>
      <div className="ml-auto pb-1">{actions}</div>
    </div>
  );
}

const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="py-2 text-sm text-muted-foreground">{children}</p>
);

/**
 * "N need you" in the status line: the Decisions feed's count, plus what is waiting on a
 * thread inside each subproject (its own requests show on its page).
 */
function NeedsYouCount({ summary }: { readonly summary: OrchestratorSummary }) {
  const count = useDecisionFeedCount(summary) + subprojectNeedsYou(summary);
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-warning-foreground">
      <CircleAlertIcon className="size-4" />
      {count} need you
    </span>
  );
}

/** What is stuck on the project, derived from threads and tasks; the same rows feed the widget and the status line. */
/** Without a recorded visit, "since your last visit" means the last day. */
const FIRST_VISIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function useBlockedRows(summary: OrchestratorSummary): BlockedRow[] {
  const { statuses, query } = useTaskStatuses(summary);
  const now = query.dataUpdatedAt ?? 0;
  return useMemo(
    () =>
      deriveBlocked({
        blockedWorkers: summary.blocked,
        issues: query.data?.issues ?? [],
        statuses,
        threads: [summary.root, ...summary.descendants],
        rootThreadId: summary.root.id,
        now,
      }),
    [now, query.data, statuses, summary.blocked, summary.descendants, summary.root],
  );
}

/** "N blocked" in the status line: the blocked tags and notes under Workstreams, counted, plus blocked threads inside subprojects. */
function BlockedCount({ summary }: { readonly summary: OrchestratorSummary }) {
  const count = useBlockedRows(summary).length + subprojectBlocked(summary);
  return count > 0 ? <span className="text-error">{count} blocked</span> : null;
}

/** A subproject's health chip and sentence, from its own page data. */
function SubprojectHealth({ summary }: { readonly summary: OrchestratorSummary }) {
  const dashboard = useEnvironmentQuery(
    projectDashboardQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
  const health = dashboard.data?.health ?? null;
  if (health === null) return null;
  return (
    <>
      <span
        className={`shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-medium ${HEALTH_TONE[health.status]}`}
      >
        {HEALTH_LABEL[health.status]}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{health.sentence}</span>
    </>
  );
}

/** Column widths of the subprojects table; the header row and every row share them. */
const SUBPROJECT_COLUMN = {
  name: "sm:w-48 sm:flex-none",
  progress: "hidden w-16 shrink-0 text-right sm:block",
  working: "hidden w-16 shrink-0 text-right sm:block",
  needsYou: "hidden w-24 shrink-0 text-right sm:block",
  activity: "w-20 shrink-0 text-right",
} as const;

/**
 * One table row per direct subproject: its health, task progress, who is working, what waits
 * on you inside it and when it last moved. A row opens the subproject's own page. Below `sm`
 * the columns collapse into one meta line under the name.
 */
function ProjectSubprojects({ summary }: { readonly summary: OrchestratorSummary }) {
  const navigate = useNavigate();
  if (summary.subprojects.length === 0) return null;
  return (
    <ProjectSection title="Subprojects" count={summary.subprojects.length}>
      <div aria-hidden className="hidden gap-3 pb-1 text-xs text-muted-foreground sm:flex">
        <span className={SUBPROJECT_COLUMN.name}>Name</span>
        <span className="min-w-0 flex-1">Health</span>
        <span className={SUBPROJECT_COLUMN.progress}>Progress</span>
        <span className={SUBPROJECT_COLUMN.working}>Working</span>
        <span className={SUBPROJECT_COLUMN.needsYou}>Needs you</span>
        <span className={SUBPROJECT_COLUMN.activity}>Last active</span>
      </div>
      <ul className="divide-y divide-border">
        {summary.subprojects.map((sub) => {
          const progress = taskProgressLabel(sub);
          const working =
            sub.rollup.working > 0
              ? String(sub.rollup.working)
              : subprojectIsActive(sub)
                ? "Working"
                : null;
          const needsYou = sub.rollup.needsYou > 0 ? `${sub.rollup.needsYou} need you` : null;
          const blocked = sub.rollup.blocked > 0;
          return (
            <ClickableRow
              key={`${sub.root.environmentId}:${sub.root.id}`}
              label={`Open ${sub.root.title} subproject`}
              onOpen={() =>
                void navigate({
                  to: "/orchestrators/$environmentId/$threadId",
                  params: { environmentId: sub.root.environmentId, threadId: sub.root.id },
                })
              }
              className="flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-sm sm:flex-nowrap"
            >
              <span className={`min-w-0 flex-1 truncate font-medium ${SUBPROJECT_COLUMN.name}`}>
                <span className="text-muted-foreground">/ </span>
                {sub.root.title}
              </span>
              <span className="order-last flex min-w-0 basis-full items-baseline gap-2 sm:order-none sm:basis-auto sm:flex-1">
                <SubprojectHealth summary={sub} />
              </span>
              <span className={SUBPROJECT_COLUMN.progress}>
                {progress === null ? null : <span className="tabular-nums">{progress}</span>}
              </span>
              <span className={`${SUBPROJECT_COLUMN.working} text-muted-foreground`}>
                {working}
              </span>
              <span className={SUBPROJECT_COLUMN.needsYou}>
                {blocked ? <span className="text-error">Blocked </span> : null}
                {needsYou === null ? null : (
                  <span className="text-warning-foreground">{needsYou}</span>
                )}
              </span>
              <span className={`${SUBPROJECT_COLUMN.activity} text-xs text-muted-foreground`}>
                {formatRelativeTimeLabel(sub.rollup.latestActivityAt)}
              </span>
              <span className="order-last basis-full text-xs text-muted-foreground sm:hidden empty:hidden">
                {[
                  blocked ? "Blocked" : null,
                  needsYou,
                  working === null ? null : working === "Working" ? working : `${working} working`,
                  progress === null ? null : `${progress} tasks`,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            </ClickableRow>
          );
        })}
      </ul>
    </ProjectSection>
  );
}

/**
 * The Dashboard's Team strip and Workstreams block: each active epic with the threads working on
 * it, and Other threads for sub-agents outside any workstream (see WorkstreamBands),
 * with what changed since Brad's previous visit, or the last day when there is none.
 * Hidden while there is nothing to show.
 */
function ProjectWorkstreams({
  summary,
  since,
}: {
  readonly summary: OrchestratorSummary;
  readonly since: string | null;
}) {
  const tasks = useTaskStatuses(summary);
  const [firstVisitSince] = useState(() =>
    new Date(Date.now() - FIRST_VISIT_WINDOW_MS).toISOString(),
  );
  const workstreams = useWorkstreamBands(summary, tasks, since ?? firstVisitSince);
  const bands = useMemo(
    () =>
      workstreams.bands.filter(
        (band) =>
          band.epic !== null &&
          (band.rows.length > 0 || (workstreams.threads.byBand.get(band.key)?.length ?? 0) > 0),
      ),
    [workstreams.bands, workstreams.threads.byBand],
  );
  const hasWorkstreams = bands.length > 0 || workstreams.threads.other.length > 0;
  if (!hasWorkstreams && workstreams.team.length === 0) return null;
  return (
    <>
      {workstreams.team.length > 0 ? (
        <ProjectSection title="Team" count={workstreams.team.length}>
          <TeamStrip summary={summary} team={workstreams.team} now={workstreams.now} />
        </ProjectSection>
      ) : null}
      {hasWorkstreams ? (
        <ProjectSection title="Workstreams" count={bands.length}>
          <WorkstreamBands summary={summary} workstreams={workstreams} bands={bands} compact />
        </ProjectSection>
      ) : null}
    </>
  );
}

interface BoardPage {
  readonly summary: OrchestratorSummary;
  readonly selectTab: (tab: ProjectTab) => void;
  readonly roadmapTab: string | null;
  readonly tasksTab: string | null;
  readonly chatOpen: boolean;
  readonly setChatOpen: (open: boolean) => void;
  readonly rootRef: ReturnType<typeof scopeThreadRef>;
  readonly decisionsInLayout: boolean;
  readonly revealSentMessage: (messageId: import("@t3tools/contracts").MessageId) => void;
}

/** A built-in widget of the layout, by type, with its settings. */
function BuiltinWidget({
  widget,
  page,
}: {
  readonly widget: ProjectLayoutWidget;
  readonly page: BoardPage;
}) {
  const {
    summary,
    selectTab,
    roadmapTab,
    tasksTab,
    chatOpen,
    setChatOpen,
    rootRef,
    revealSentMessage,
  } = page;
  switch (widget.type) {
    case "requests":
      return (
        <ProjectRequestsSection
          summary={summary}
          includeLater={widget.config.includeLater === true}
        />
      );
    case "release":
      return <ProjectReleaseWidget summary={summary} />;
    case "maintenance":
      return (
        <ProjectMaintenanceWidget
          summary={summary}
          includeLater={widget.config.includeLater === true}
        />
      );
    case "roadmap-summary":
      return (
        <ProjectRoadmapSummary
          summary={summary}
          onOpen={roadmapTab ? () => selectTab(roadmapTab) : null}
        />
      );
    case "roadmap-board":
      return <ProjectRoadmapWidget summary={summary} />;
    case "issues-board":
      return (
        <ProjectIssuesBoard
          summary={summary}
          pendingPreview={Number(widget.config.pendingPreview ?? 10)}
        />
      );
    case "decisions":
      return <ProjectDecisionFeed summary={summary} />;
    case "needs-you":
      // Needs you folded into the Decisions feed; a layout without a Decisions widget keeps it here.
      return page.decisionsInLayout ? null : <ProjectDecisionFeed summary={summary} />;
    case "composer":
      return (
        <ProjectSection title="New request">
          {chatOpen ? (
            <Button size="sm" variant="outline" onClick={() => setChatOpen(true)}>
              <MessageSquareIcon />
              Open chat
            </Button>
          ) : (
            <div className="relative h-44 overflow-hidden">
              <ChatView
                routeKind="server"
                environmentId={rootRef.environmentId}
                threadId={rootRef.threadId}
                presentation="project-request"
                onMessageSent={revealSentMessage}
              />
            </div>
          )}
          <div className="mt-2">
            <SaveForLater summary={summary} />
          </div>
        </ProjectSection>
      );
    case "issues-summary":
      return (
        <ProjectIssuesSummary
          summary={summary}
          onOpen={tasksTab ? () => selectTab(tasksTab) : null}
          includeLater={widget.config.includeLater === true}
        />
      );
    case "prs":
      return <ProjectPullRequestsWidget summary={summary} />;
    case "automations":
      return (
        <ProjectAutomationsSlot
          project={{
            environmentId: summary.root.environmentId,
            rootThreadId: summary.root.id,
            rootProjectId: summary.root.projectId,
          }}
        />
      );
    default:
      return null;
  }
}

const HEALTH_TONE = {
  "on-track": "bg-success/12 text-success",
  "at-risk": "bg-warning/12 text-warning",
  "off-track": "bg-error/12 text-error",
  "waiting-on-you": "bg-info/12 text-info",
} as const;

/**
 * The orchestrator's one-line health status (`t3-thread project health set`): a
 * chip, one sentence and when it was written. Older than a day, or older than
 * the newest work change, it shows as stale.
 */
function ProjectHealthLine({ summary }: { readonly summary: OrchestratorSummary }) {
  const dashboard = useEnvironmentQuery(
    projectDashboardQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
  const health = dashboard.data?.health ?? null;
  if (health === null) return null;
  const stale = isHealthStale(health, latestWorkChangeAt(summary), Date.now());
  return (
    <p className="text-sm">
      <span
        className={`mr-2 rounded-sm px-1.5 py-0.5 text-xs font-medium ${HEALTH_TONE[health.status]}`}
      >
        {HEALTH_LABEL[health.status]}
      </span>
      {health.sentence}
      <span className={`ml-2 text-xs ${stale ? "text-warning" : "text-muted-foreground"}`}>
        {stale ? "Stale, as of " : "As of "}
        {formatRelativeTimeLabel(health.updatedAt)}
      </span>
    </p>
  );
}

export function OrchestratorBoard({
  environmentId,
  threadId,
  tab: tabFromUrl = null,
  onTabChange,
  task = null,
  onTaskChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The tab in the URL, or null to use the tab this device last used for the project. */
  readonly tab?: ProjectTab | null;
  readonly onTabChange?: (tab: ProjectTab) => void;
  readonly task?: TaskRef | null;
  readonly onTaskChange?: (task: TaskRef | null) => void;
}) {
  const [rememberedTab, setRememberedTab] = useLocalStorage(
    `t3code:projects:tab:${environmentId}:${threadId}`,
    "dashboard",
    Schema.String,
  );
  const layoutState = useProjectLayout(environmentId, threadId);
  const applyLayout = useAtomCommand(applyProjectLayout, "Change layout");
  const [editingLayout, setEditingLayout] = useState(false);
  // An edit shows at once; the server's next revision replaces it.
  const [optimistic, setOptimistic] = useState<{
    readonly base: number;
    readonly tabs: ReadonlyArray<ProjectLayoutTab>;
  } | null>(null);
  // Older servers still send widgets the page has retired; they are dropped here too.
  const layoutTabs = withoutRetiredWidgets(
    optimistic && optimistic.base === layoutState.layout.revision
      ? optimistic.tabs
      : layoutState.layout.tabs,
  );
  const tab = resolveProjectTab(
    tabFromUrl,
    rememberedTab,
    layoutTabs.map((item) => item.id),
  );
  const changeLayout = (ops: ProjectLayoutOp[]) => {
    if (!layoutState.live) {
      toastManager.add({
        type: "error",
        title: "Update this server to edit layouts",
      });
      return;
    }
    const next = applyLayoutOps(layoutTabs, ops);
    if ("error" in next) {
      toastManager.add({
        type: "error",
        title: "Could not change the layout",
        description: next.error,
      });
      return;
    }
    const base = layoutState.layout.revision;
    setOptimistic({ base, tabs: next.tabs });
    void applyLayout({
      environmentId,
      input: { threadId, baseRevision: base, ops },
    }).then((result) => {
      if (result._tag === "Failure") setOptimistic(null);
    });
  };
  const selectTab = (next: ProjectTab) => {
    setRememberedTab(next);
    onTabChange?.(next);
  };
  const projects = useProjects();
  const threads = useOrchestratorThreadShells();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const updateProjectScope = useAtomCommand(updateProjectScopeCommand, {
    reportFailure: false,
  });
  const setSubproject = useAtomCommand(setThreadSubprojectCommand, "Change subproject");
  const [chatOpen, setChatOpen] = useLocalStorage(
    `t3code:projects:orchestrator-chat-open:${environmentId}:${threadId}`,
    false,
    Schema.Boolean,
  );
  const [revealedMessageId, setRevealedMessageId] = useState<
    import("@t3tools/contracts").MessageId | null
  >(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editScope, setEditScope] = useState("");
  const supervisionReadyHosts = useSupervisionReadyHosts();
  const [editTracker, setEditTracker] = useState("");
  const dashboard = useEnvironmentQuery(
    projectDashboardQuery({ environmentId, input: { threadId } }),
  );
  const saveTracker = useAtomCommand(setProjectDashboardTracker, "Save task repository");
  const summaries = useMemo(
    () => buildOrchestratorSummaries(threads, projects),
    [projects, threads],
  );
  const summary = useMemo(
    () =>
      summaries.find(
        (item) => item.root.environmentId === environmentId && item.root.id === threadId,
      ) ?? null,
    [environmentId, summaries, threadId],
  );
  const trail = useMemo(
    () => (summary === null ? [] : projectTrail(summaries, summary)),
    [summaries, summary],
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

  useEffect(() => {
    recordOrchestratorVisit(window.localStorage, environmentId, threadId, new Date().toISOString());
  }, [environmentId, threadId]);

  if (summary === null) {
    // Until the host's nesting metadata has loaded, a project's workers are not attached to it, so
    // a deep link or reload cannot tell a missing project from one still loading.
    const loading = !supervisionReadyHosts.has(environmentId);
    return (
      <SidebarInset className="h-dvh">
        <WorkspacePageContainer>
          <Empty>{loading ? "Loading project…" : "This project is no longer available."}</Empty>
        </WorkspacePageContainer>
      </SidebarInset>
    );
  }

  const rootProject =
    summary.projects.find(
      (project) =>
        project.environmentId === summary.root.environmentId &&
        project.id === summary.root.projectId,
    ) ?? summary.projects[0];
  const rootRef = scopeThreadRef(summary.root.environmentId, summary.root.id);
  const openEditor = () => {
    setEditTitle(summary.root.title);
    setEditScope(summary.root.scope ?? "");
    setEditTracker(dashboard.data?.tracker ?? "");
    setEditing(true);
  };
  const saveIdentity = async () => {
    const title = editTitle.trim();
    if (!title) return;
    const scope = editScope.trim() || null;
    const results = [];
    if (title !== summary.root.title) {
      results.push(
        await updateThreadMetadata({
          environmentId: summary.root.environmentId,
          input: { threadId: summary.root.id, title },
        }),
      );
    }
    if (scope !== (summary.root.scope ?? null)) {
      results.push(
        await updateProjectScope({
          environmentId: summary.root.environmentId,
          input: { commandId: CommandId.make(randomUUID()), threadId: summary.root.id, scope },
        }),
      );
    }
    for (const result of results) {
      if (result._tag !== "Failure") continue;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not update project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return;
    }
    const tracker = editTracker.trim() || null;
    if (tracker !== (dashboard.data?.tracker ?? null)) {
      const saved = await saveTracker({
        environmentId: summary.root.environmentId,
        input: { threadId: summary.root.id, tracker },
      });
      dashboard.refresh();
      if (saved._tag === "Failure") return;
    }
    setEditing(false);
  };
  /** Turns a subproject back into a plain worker of its parent; its page goes away. */
  const showAsWorker = async () => {
    const result = await setSubproject({
      environmentId: summary.root.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        threadId: summary.root.id,
        subproject: "off",
      },
    });
    if (result._tag === "Failure") return;
    setEditing(false);
    const parent = trail.at(-1);
    void navigate(
      parent
        ? {
            to: "/orchestrators/$environmentId/$threadId",
            params: { environmentId: parent.root.environmentId, threadId: parent.root.id },
          }
        : { to: "/" },
    );
  };
  const revealSentMessage = (messageId: import("@t3tools/contracts").MessageId) => {
    setRevealedMessageId(messageId);
    setChatOpen(true);
  };

  const activeTab = layoutTabs.find((item) => item.id === tab) ?? layoutTabs[0] ?? null;
  /** The tab holding a board, for the Dashboard's summary lines to open. */
  const tabWith = (type: string) =>
    layoutTabs.find((item) => item.widgets.some((widget) => widget.type === type))?.id ?? null;
  const roadmapTab = tabWith("roadmap-board");
  const tasksTab = tabWith("issues-board");
  const page: BoardPage = {
    summary,
    selectTab,
    roadmapTab,
    tasksTab,
    chatOpen,
    setChatOpen,
    rootRef,
    decisionsInLayout: tabWith("decisions") !== null,
    revealSentMessage,
  };

  return (
    <OpenTaskContext value={onTaskChange ?? null}>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspacePageHeader electron={isElectron} className="bg-background">
            {rootProject ? <ProjectFavicon project={rootProject} className="size-5" /> : null}
            <WorkspaceBreadcrumb ariaLabel="Project breadcrumb">
              {trail.map((ancestor) => (
                <WorkspaceBreadcrumbItem
                  key={`${ancestor.root.environmentId}:${ancestor.root.id}`}
                  className="shrink"
                >
                  <button
                    type="button"
                    className="max-w-24 cursor-pointer truncate hover:text-foreground hover:underline sm:max-w-48"
                    onClick={() =>
                      void navigate({
                        to: "/orchestrators/$environmentId/$threadId",
                        params: {
                          environmentId: ancestor.root.environmentId,
                          threadId: ancestor.root.id,
                        },
                      })
                    }
                  >
                    {ancestor.root.title}
                  </button>
                  <span aria-hidden className="pl-2 sm:pl-3">
                    /
                  </span>
                </WorkspaceBreadcrumbItem>
              ))}
              <WorkspaceBreadcrumbItem current>
                <span className="flex min-w-0 flex-col">
                  <h1 className="truncate">{summary.root.title}</h1>
                  {summary.root.scope ? (
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {summary.root.scope}
                    </span>
                  ) : null}
                </span>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={openEditor}>
              <PencilIcon />
              Edit
            </Button>
            <Button
              size="sm"
              variant={chatOpen ? "secondary" : "outline"}
              onClick={() => setChatOpen((open) => !open)}
            >
              <MessageSquareIcon />
              {chatOpen ? "Hide chat" : "Chat"}
            </Button>
          </WorkspacePageHeader>
          <div className="flex min-h-0 flex-1 border-t border-border">
            <div className="topbar-scroll-fade min-h-0 min-w-0 flex-1 overflow-y-auto">
              <WorkspacePageContainer width="wide" className="gap-5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                  <OrchestratorStatus status={summary.status} />
                  {summary.rollup.working > 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <UsersIcon className="size-4" />
                      {summary.rollup.working} working
                    </span>
                  ) : null}
                  <NeedsYouCount summary={summary} />
                  <BlockedCount summary={summary} />
                  <span className="text-xs text-muted-foreground">
                    {summary.projects.map((project) => project.title).join(" · ")}
                  </span>
                </div>

                <ProjectHealthLine summary={summary} />
                {tab === "dashboard" ? <ProjectSubprojects summary={summary} /> : null}
                {tab === "dashboard" ? (
                  <ProjectWorkstreams summary={summary} since={previousVisit} />
                ) : null}
                <ProjectReleaseLine
                  summary={summary}
                  runningVersion={
                    serverConfigs.get(summary.root.environmentId)?.environment.serverVersion ?? null
                  }
                />
                {/* On every tab, above the tabs: one line until it is used. */}
                <ProjectRequestBox summary={summary} />
                <ProjectTabBar
                  tabs={layoutTabs}
                  tab={tab}
                  onSelect={selectTab}
                  editing={editingLayout}
                  onApply={changeLayout}
                  actions={
                    layoutState.live ? (
                      <Button
                        size="xs"
                        variant={editingLayout ? "secondary" : "ghost-muted"}
                        onClick={() => setEditingLayout((value) => !value)}
                      >
                        <SlidersHorizontalIcon />
                        {editingLayout ? "Done" : "Edit layout"}
                      </Button>
                    ) : null
                  }
                />
                {activeTab ? (
                  <ProjectLayoutTabView
                    summary={summary}
                    tabs={layoutTabs}
                    tab={activeTab}
                    editing={editingLayout}
                    builtins={
                      new Map(
                        activeTab.widgets.map((widget) => [
                          widget.id,
                          <BuiltinWidget key={widget.id} widget={widget} page={page} />,
                        ]),
                      )
                    }
                    onApply={changeLayout}
                  />
                ) : null}
              </WorkspacePageContainer>
            </div>
            {task ? (
              <ProjectTaskPanel
                summary={summary}
                task={task}
                onClose={() => onTaskChange?.(null)}
              />
            ) : chatOpen ? (
              <aside className="flex w-full min-w-0 shrink-0 flex-col border-l border-border sm:w-[400px]">
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
                  <MessageSquareIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {summary.root.title}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Open the full orchestrator thread"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(rootRef),
                        state: projectReturnState({
                          environmentId: summary.root.environmentId,
                          threadId: summary.root.id,
                        }),
                      })
                    }
                  >
                    <ArrowUpRightIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Close orchestrator chat"
                    onClick={() => setChatOpen(false)}
                  >
                    <XIcon />
                  </Button>
                </div>
                <ChatView
                  routeKind="server"
                  environmentId={rootRef.environmentId}
                  threadId={rootRef.threadId}
                  presentation="project-panel"
                  revealMessageId={revealedMessageId}
                />
              </aside>
            ) : null}
          </div>
        </div>
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Edit project</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 px-6 pb-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Title
                <Input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Scope
                <Textarea
                  value={editScope}
                  rows={2}
                  maxLength={500}
                  placeholder="Coordinates the entire repo"
                  onChange={(event) => setEditScope(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Task repository
                <Input
                  value={editTracker}
                  placeholder="owner/repo, only when the code is not on Gitea"
                  onChange={(event) => setEditTracker(event.target.value)}
                />
              </label>
            </div>
            <DialogFooter>
              {summary.parentProjectKey !== null ? (
                <Button variant="ghost" className="mr-auto" onClick={() => void showAsWorker()}>
                  Show as worker
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button disabled={editTitle.trim().length === 0} onClick={() => void saveIdentity()}>
                Save
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </SidebarInset>
    </OpenTaskContext>
  );
}
