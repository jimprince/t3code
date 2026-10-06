import {
  buildOrchestratorSummaries,
  orchestratorDoneSince,
  type OrchestratorSummary,
} from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
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
import { Button, InlineButton } from "../ui/button";
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
import { ProjectDecisionsWidget } from "./ProjectDecisionsWidget";
import { ProjectIssuesBoard } from "./ProjectIssuesBoard";
import { ProjectTaskPanel } from "./ProjectTaskPanel";
import { OpenTaskContext, TaskTitle } from "./TaskLink";
import { deriveWorkstreams } from "./projectWorkstreams.logic";
import type { TaskRef } from "./taskView.logic";
import {
  ClickableRow,
  NeedsYouIssueGroups,
  ProjectMaintenanceWidget,
  ProjectReleaseLine,
  ProjectReleaseWidget,
  ProjectRequestsSection,
  useNeedsYou,
  useOpenThread,
  useProjectRequests,
  useSettle,
  useTaskStatuses,
  WorkerRequestTag,
} from "./ProjectRequestsSection";
import { ProjectLayoutTabView, TAB_DRAG_TYPE, WIDGET_DRAG_TYPE } from "./ProjectLayoutView";
import { ProjectRoadmapWidget, SaveForLater } from "./ProjectRoadmapWidget";
import { ProjectPullRequestsWidget } from "./ProjectPullRequestsWidget";
import { ProjectRequestBox } from "./ProjectRequestBox";
import { ProjectSection } from "./ProjectSection";
import { ProjectIssuesSummary, ProjectRoadmapSummary } from "./ProjectTabSummaries";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { resolveProjectTab, type ProjectTab } from "./projectTabs.logic";
import { HEALTH_LABEL, isHealthStale, latestWorkChangeAt } from "./projectHealth.logic";
import { issueKey } from "./projectRequests.logic";
import {
  deriveBlocked,
  deriveWorkingNow,
  type BlockedRow,
  type WorkingRow,
} from "./projectWork.logic";
import { projectReturnState } from "./projectNavigation";

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
 * Everything waiting on Brad, from one source: threads asking for an approval,
 * an answer or a plan review, then the requests and issues the Issues board's
 * Needs you lane shows. Hidden when nothing waits.
 */
function ProjectNeedsYouWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { items, query } = useNeedsYou(summary);
  const settle = useSettle(summary, query.refresh);
  const openThread = useOpenThread(summary);
  const count = summary.needsYou.length + items.length;
  if (count === 0) return null;
  return (
    <ProjectSection title="Needs you" count={count}>
      {summary.needsYou.length > 0 ? (
        <ul className="mb-3 divide-y divide-border">
          {summary.needsYou.map((item) => (
            <ClickableRow
              key={`${item.kind}:${item.thread.id}`}
              label={`Open ${item.thread.title}`}
              onOpen={() => openThread(item.thread.id)}
              className="items-start py-1.5"
            >
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
              <span className="min-w-0 flex-1 text-sm">{item.thread.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.kind === "approval"
                  ? "Approval"
                  : item.kind === "input"
                    ? "Question"
                    : "Plan ready"}
              </span>
            </ClickableRow>
          ))}
        </ul>
      ) : null}
      <NeedsYouIssueGroups
        summary={summary}
        items={items}
        settle={settle}
        refresh={query.refresh}
      />
    </ProjectSection>
  );
}

/** "N need you" in the status line: the same count as the Needs you widget. */
function NeedsYouCount({ summary }: { readonly summary: OrchestratorSummary }) {
  const { items } = useNeedsYou(summary);
  const count = summary.needsYou.length + items.length;
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-warning-foreground">
      <CircleAlertIcon className="size-4" />
      {count} need you
    </span>
  );
}

/** What is stuck on the project, derived from threads and tasks; the same rows feed the widget and the status line. */
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

/** "N blocked" in the status line: the same count as the Blocked widget. */
function BlockedCount({ summary }: { readonly summary: OrchestratorSummary }) {
  const count = useBlockedRows(summary).length;
  return count > 0 ? <span className="text-error">{count} blocked</span> : null;
}

/** Stuck work with its cause, owner and next step; hidden when nothing is stuck. */
function ProjectBlockedWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const rows = useBlockedRows(summary);
  const openThread = useOpenThread(summary);
  if (rows.length === 0) return null;
  return (
    <ProjectSection title="Blocked" count={rows.length}>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <ClickableRow
            key={row.key}
            label={`Open ${row.owner?.title ?? row.title}`}
            onOpen={row.owner ? () => openThread(row.owner!.id) : null}
            className="items-start py-1.5"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{row.title}</span>
              <span className="block text-xs text-muted-foreground">
                <span className="text-error">{row.cause}</span>
                {/* The owner only when it says more than the title. */}
                {row.owner && row.owner.title !== row.title ? ` · ${row.owner.title}` : ""}
                {row.next ? ` · next: ${row.next}` : ""}
              </span>
            </span>
            {row.action ? (
              <Button
                size="xs"
                variant="outline"
                render={<a href={row.action.url} target="_blank" rel="noopener noreferrer" />}
              >
                {row.action.label}
              </Button>
            ) : null}
          </ClickableRow>
        ))}
      </ul>
    </ProjectSection>
  );
}

/**
 * One line per active epic under the health line: its phase or milestone, N of
 * M, the workers on it, the next step, and Blocked. Derived from the epics and
 * their children only; hidden while no epic has work left. A row opens the epic.
 */
function ProjectWorkstreams({ summary }: { readonly summary: OrchestratorSummary }) {
  const { statuses, query } = useTaskStatuses(summary);
  const blockedRows = useBlockedRows(summary);
  const rows = useMemo(
    () =>
      deriveWorkstreams({
        issues: query.data?.issues ?? [],
        statuses,
        workingThreadIds: new Set(summary.working.map((item) => item.thread.id as string)),
        blockedRows,
        rootThreadId: summary.root.id,
      }),
    [blockedRows, query.data, statuses, summary.root.id, summary.working],
  );
  if (rows.length === 0) return null;
  return (
    <ProjectSection title="Workstreams" count={rows.length}>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={issueKey(row.epic)} className="py-1.5">
            <TaskTitle
              task={{
                host: row.epic.host,
                repository: row.epic.repository,
                number: row.epic.number,
              }}
              url={row.epic.url}
              className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 text-sm hover:underline"
            >
              <span>{row.epic.title}</span>
              <span className="text-muted-foreground">
                {row.milestone ? `${row.milestone} · ` : ""}
                {row.progress}
              </span>
              {row.agents > 0 ? (
                <span className="text-muted-foreground">
                  {row.agents} {row.agents === 1 ? "agent" : "agents"}
                </span>
              ) : null}
              {row.next ? (
                <span className="text-muted-foreground">next: {row.next.title}</span>
              ) : null}
              {row.blocked ? <span className="text-error">Blocked</span> : null}
            </TaskTitle>
          </li>
        ))}
      </ul>
    </ProjectSection>
  );
}

/** Who is working on what: one outcome row per worker, opening its thread. */
function ProjectWorkingWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, requests } = useProjectRequests(summary);
  const openThread = useOpenThread(summary);
  const rows: WorkingRow[] = useMemo(
    () => deriveWorkingNow(summary.working, query.data?.issues ?? [], requests),
    [query.data, requests, summary.working],
  );
  if (rows.length === 0) return null;
  return (
    <ProjectSection title="Working now" count={rows.length}>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <ClickableRow
            key={row.key}
            label={`Open ${row.worker ?? row.title}`}
            onOpen={() => openThread(row.threadId)}
            className="items-start py-1.5"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm">
                {row.title}
                <span className="text-muted-foreground">
                  {row.next ? ` · next: ${row.next}` : ""}
                  {row.worker && row.worker !== row.title ? ` · ${row.worker}` : ""}
                </span>
              </span>
              {row.forRequests.length > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  for: {row.forRequests.join(" · ")}
                </span>
              ) : null}
            </span>
          </ClickableRow>
        ))}
      </ul>
    </ProjectSection>
  );
}

/** A worker row (Done) that opens its thread when clicked. */
function WorkerRow({
  summary,
  thread,
  trailing,
}: {
  readonly summary: OrchestratorSummary;
  readonly thread: EnvironmentThreadShell;
  readonly trailing: ReactNode;
}) {
  const openThread = useOpenThread(summary);
  return (
    <ClickableRow
      label={`Open ${thread.title}`}
      onOpen={() => openThread(thread.id)}
      className="items-start py-1.5"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{thread.title}</span>
        <WorkerRequestTag summary={summary} threadId={thread.id} />
      </span>
      {trailing}
    </ClickableRow>
  );
}

/** Rows "Done since your last visit" shows before "Show all". */
const DONE_PREVIEW = 5;
/** Without a recorded visit, "since your last visit" means the last day. */
const FIRST_VISIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Workers that finished since Brad last opened the page, newest first; hidden when none did. */
function ProjectDoneWidget({
  summary,
  done,
}: {
  readonly summary: OrchestratorSummary;
  readonly done: ReturnType<typeof orchestratorDoneSince>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [now] = useState(() => Date.now());
  if (done.length === 0) return null;
  const shown = showAll ? done : done.slice(0, DONE_PREVIEW);
  return (
    <ProjectSection title="Done since your last visit" count={done.length}>
      <ul className="divide-y divide-border">
        {shown.map((item) => (
          <WorkerRow
            key={item.thread.id}
            summary={summary}
            thread={item.thread}
            trailing={
              <time
                className="w-8 shrink-0 pt-px text-right text-xs tabular-nums text-muted-foreground"
                dateTime={item.completedAt}
              >
                {formatIssueAge(item.completedAt, now)}
              </time>
            }
          />
        ))}
      </ul>
      {done.length > DONE_PREVIEW ? (
        <p className="mt-1 text-xs">
          <InlineButton tone="muted" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${done.length}`}
          </InlineButton>
        </p>
      ) : null}
    </ProjectSection>
  );
}

interface BoardPage {
  readonly summary: OrchestratorSummary;
  readonly done: ReturnType<typeof orchestratorDoneSince>;
  readonly selectTab: (tab: ProjectTab) => void;
  readonly roadmapTab: string | null;
  readonly tasksTab: string | null;
  readonly chatOpen: boolean;
  readonly setChatOpen: (open: boolean) => void;
  readonly rootRef: ReturnType<typeof scopeThreadRef>;
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
    done,
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
      return <ProjectDecisionsWidget summary={summary} />;
    case "needs-you":
      return <ProjectNeedsYouWidget summary={summary} />;
    case "working":
      return <ProjectWorkingWidget summary={summary} />;
    case "blocked":
      return <ProjectBlockedWidget summary={summary} />;
    case "done":
      return <ProjectDoneWidget summary={summary} done={done} />;
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
  const layoutTabs =
    optimistic && optimistic.base === layoutState.layout.revision
      ? optimistic.tabs
      : layoutState.layout.tabs;
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
  const summary = useMemo(
    () =>
      buildOrchestratorSummaries(threads, projects).find(
        (item) => item.root.environmentId === environmentId && item.root.id === threadId,
      ) ?? null,
    [environmentId, projects, threadId, threads],
  );
  const [openedAt] = useState(() => Date.now());
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
    () =>
      summary === null
        ? []
        : orchestratorDoneSince(
            summary,
            previousVisit ?? new Date(openedAt - FIRST_VISIT_WINDOW_MS).toISOString(),
          ),
    [openedAt, previousVisit, summary],
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
    done,
    selectTab,
    roadmapTab,
    tasksTab,
    chatOpen,
    setChatOpen,
    rootRef,
    revealSentMessage,
  };

  return (
    <OpenTaskContext value={onTaskChange ?? null}>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspacePageHeader electron={isElectron} className="bg-background">
            {rootProject ? <ProjectFavicon project={rootProject} className="size-5" /> : null}
            <WorkspaceBreadcrumb ariaLabel="Project breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <span className="flex min-w-0 flex-col">
                  <h1>{summary.root.title}</h1>
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
                  {summary.activeWorkerCount > 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <UsersIcon className="size-4" />
                      {summary.activeWorkerCount} working
                    </span>
                  ) : null}
                  <NeedsYouCount summary={summary} />
                  <BlockedCount summary={summary} />
                  <span className="text-xs text-muted-foreground">
                    {summary.projects.map((project) => project.title).join(" · ")}
                  </span>
                </div>

                <ProjectHealthLine summary={summary} />
                {tab === "dashboard" ? <ProjectWorkstreams summary={summary} /> : null}
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
