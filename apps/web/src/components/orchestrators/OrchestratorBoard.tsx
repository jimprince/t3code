import {
  buildOrchestratorSummaries,
  orchestratorDoneSince,
  type OrchestratorSummary,
} from "@t3tools/client-runtime/state/orchestrators";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  MessageSquareIcon,
  PencilIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatView from "../ChatView";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
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
import { readOrchestratorLastVisit, recordOrchestratorVisit } from "./orchestratorVisit";
import { ProjectAutomationsSlot } from "../projects/ProjectAutomationsSlot";
import { ProjectIssuesBoard } from "./ProjectIssuesBoard";
import {
  ClickableRow,
  NeedsYouIssueGroups,
  ProjectMaintenanceWidget,
  ProjectReleaseLine,
  ProjectReleaseWidget,
  ProjectRequestsSection,
  useNeedsYou,
  useOpenThread,
  useSettle,
} from "./ProjectRequestsSection";
import { ProjectWidgetList, WorkerRequestTag } from "./ProjectWidgetList";
import { ProjectRoadmapWidget, SaveForLater } from "./ProjectRoadmapWidget";
import { ProjectPullRequestsWidget } from "./ProjectPullRequestsWidget";
import { ProjectRequestBox } from "./ProjectRequestBox";
import { ProjectIssuesSummary, ProjectRoadmapSummary } from "./ProjectTabSummaries";
import { PROJECT_TABS, resolveProjectTab, type ProjectTab } from "./projectTabs.logic";
import type { ProjectWidgetId } from "./projectWidgets.logic";
import { projectReturnState } from "./projectNavigation";

/** Dashboard | Issues | Roadmap, with the tab's own actions (Customize) at the right. */
function ProjectTabBar({
  tab,
  onSelect,
  actions,
}: {
  readonly tab: ProjectTab;
  readonly onSelect: (tab: ProjectTab) => void;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex items-end gap-4 border-b border-border">
      <div role="tablist" aria-label="Project views" className="flex gap-4">
        {PROJECT_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`-mb-px border-b-2 px-0.5 pb-2 text-sm ${
              tab === item.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onSelect(item.id)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div className="ml-auto pb-1">{actions}</div>
    </div>
  );
}

function BoardSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count === undefined ? null : (
          <span className="tabular-nums text-foreground/60">{count}</span>
        )}
      </h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="py-2 text-sm text-muted-foreground">{children}</p>
);
const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();

function ThreadProviderModel({
  thread,
  entries,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly entries: ReadonlyMap<string, ProviderInstanceEntry>;
}) {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const entry = entries.get(instanceId) ?? null;
  const model = entry?.models.find((candidate) => candidate.slug === thread.modelSelection.model);
  const modelLabel = model
    ? getTriggerDisplayModelLabel(model)
    : thread.modelSelection.model || "Default model";
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {entry ? (
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          showBadge={shouldShowInstanceBadge(entry, entries.values())}
          className="size-4"
          iconClassName="size-3.5"
          badgeClassName="-right-1 -bottom-1"
        />
      ) : null}
      <span className="max-w-32 truncate">{modelLabel}</span>
    </span>
  );
}

/**
 * Everything waiting on Brad, from one source: threads asking for an approval,
 * an answer or a plan review, then the requests and issues the Issues board's
 * Needs you lane shows. Hidden when nothing waits.
 */
function ProjectNeedsYouWidget({
  summary,
  providerEntriesFor,
}: {
  readonly summary: OrchestratorSummary;
  readonly providerEntriesFor: (
    thread: EnvironmentThreadShell,
  ) => ReadonlyMap<string, ProviderInstanceEntry>;
}) {
  const { items, query } = useNeedsYou(summary);
  const settle = useSettle(summary, query.refresh);
  const openThread = useOpenThread(summary);
  const count = summary.needsYou.length + items.length;
  if (count === 0) return null;
  return (
    <BoardSection title="Needs you" count={count}>
      {summary.needsYou.length > 0 ? (
        <ul className="mb-3 divide-y divide-border">
          {summary.needsYou.map((item) => (
            <ClickableRow
              key={`${item.kind}:${item.thread.id}`}
              label={`Open ${item.thread.title}`}
              onOpen={() => openThread(item.thread.id)}
              className="items-center py-2"
            >
              <CircleAlertIcon className="size-4 shrink-0 text-warning-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{item.thread.title}</span>
              <span className="text-xs text-muted-foreground">
                {item.kind === "approval"
                  ? "Approval"
                  : item.kind === "input"
                    ? "Question"
                    : "Plan ready"}
              </span>
              <ThreadProviderModel thread={item.thread} entries={providerEntriesFor(item.thread)} />
            </ClickableRow>
          ))}
        </ul>
      ) : null}
      <NeedsYouIssueGroups summary={summary} items={items} settle={settle} />
    </BoardSection>
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

/** A worker row (Working, Blocked, Done) that opens its thread when clicked. */
function WorkerRow({
  summary,
  thread,
  latestLine,
  tone = "default",
  trailing,
}: {
  readonly summary: OrchestratorSummary;
  readonly thread: EnvironmentThreadShell;
  readonly latestLine?: string | null;
  readonly tone?: "default" | "error";
  readonly trailing: ReactNode;
}) {
  const openThread = useOpenThread(summary);
  return (
    <ClickableRow
      label={`Open ${thread.title}`}
      onOpen={() => openThread(thread.id)}
      className="items-start py-2"
    >
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm font-medium ${tone === "error" ? "text-error" : ""}`}
        >
          {thread.title}
        </span>
        {latestLine ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{latestLine}</span>
        ) : null}
        <WorkerRequestTag summary={summary} threadId={thread.id} />
      </span>
      {trailing}
    </ClickableRow>
  );
}

export function OrchestratorBoard({
  environmentId,
  threadId,
  tab: tabFromUrl = null,
  onTabChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The tab in the URL, or null to use the tab this device last used for the project. */
  readonly tab?: ProjectTab | null;
  readonly onTabChange?: (tab: ProjectTab) => void;
}) {
  const [rememberedTab, setRememberedTab] = useLocalStorage(
    `t3code:projects:tab:${environmentId}:${threadId}`,
    "dashboard",
    Schema.String,
  );
  const tab = resolveProjectTab(tabFromUrl, rememberedTab);
  const selectTab = (next: ProjectTab) => {
    setRememberedTab(next);
    onTabChange?.(next);
  };
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
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
  const [customizing, setCustomizing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editScope, setEditScope] = useState("");
  const summary = useMemo(
    () =>
      buildOrchestratorSummaries(threads, projects).find(
        (item) => item.root.environmentId === environmentId && item.root.id === threadId,
      ) ?? null,
    [environmentId, projects, threadId, threads],
  );
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([serverEnvironmentId, config]) => [serverEnvironmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  const providerEntriesFor = (thread: EnvironmentThreadShell) =>
    providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES;
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
          <Empty>This project is no longer available.</Empty>
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
    setEditing(true);
  };
  const saveIdentity = async () => {
    const title = editTitle.trim();
    if (!title) return;
    const result = await updateThreadMetadata({
      environmentId: summary.root.environmentId,
      input: {
        threadId: summary.root.id,
        title,
        scope: editScope.trim() || null,
      },
    });
    if (result._tag === "Failure") {
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
    setEditing(false);
  };
  const revealSentMessage = (messageId: import("@t3tools/contracts").MessageId) => {
    setRevealedMessageId(messageId);
    setChatOpen(true);
  };

  const widgetViews: Partial<Record<ProjectWidgetId, ReactNode>> = {
    requests: <ProjectRequestsSection summary={summary} />,
    release: <ProjectReleaseWidget summary={summary} />,
    maintenance: <ProjectMaintenanceWidget summary={summary} />,
    roadmap: <ProjectRoadmapSummary summary={summary} onOpen={() => selectTab("roadmap")} />,
    "needs-you": (
      <ProjectNeedsYouWidget summary={summary} providerEntriesFor={providerEntriesFor} />
    ),
    working:
      summary.working.length > 0 ? (
        <BoardSection title="Working" count={summary.working.length}>
          <ul className="divide-y divide-border">
            {summary.working.map((item) => (
              <WorkerRow
                key={item.thread.id}
                summary={summary}
                thread={item.thread}
                latestLine={item.latestLine}
                trailing={
                  <ThreadProviderModel
                    thread={item.thread}
                    entries={providerEntriesFor(item.thread)}
                  />
                }
              />
            ))}
          </ul>
        </BoardSection>
      ) : null,
    blocked:
      summary.blocked.length > 0 ? (
        <BoardSection title="Blocked" count={summary.blocked.length}>
          <ul className="divide-y divide-border">
            {summary.blocked.map((item) => (
              <WorkerRow
                key={item.thread.id}
                summary={summary}
                thread={item.thread}
                latestLine={item.latestLine}
                tone="error"
                trailing={
                  <>
                    <time className="text-xs text-muted-foreground">
                      {formatRelativeTimeLabel(
                        item.thread.agentPanelSummary?.lastActivityAt ?? item.thread.updatedAt,
                      )}
                    </time>
                    <ThreadProviderModel
                      thread={item.thread}
                      entries={providerEntriesFor(item.thread)}
                    />
                  </>
                }
              />
            ))}
          </ul>
        </BoardSection>
      ) : null,
    done:
      done.length > 0 ? (
        <BoardSection title="Done since your last visit" count={done.length}>
          <ul className="divide-y divide-border">
            {done.map((item) => (
              <WorkerRow
                key={item.thread.id}
                summary={summary}
                thread={item.thread}
                trailing={
                  <time className="text-xs text-muted-foreground" dateTime={item.completedAt}>
                    {formatRelativeTimeLabel(item.completedAt)}
                  </time>
                }
              />
            ))}
          </ul>
        </BoardSection>
      ) : null,
    "new-request": (
      <BoardSection title="New request">
        {chatOpen ? (
          <Button size="sm" variant="outline" onClick={() => setChatOpen(true)}>
            Continue in orchestrator chat
            <MessageSquareIcon />
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
      </BoardSection>
    ),
    issues: <ProjectIssuesSummary summary={summary} onOpen={() => selectTab("issues")} />,
    prs: <ProjectPullRequestsWidget summary={summary} />,
    // The panel is shared with project settings; here its heading matches the
    // page's other widget headings.
    automations: (
      <div className="border-t border-border pt-4 [&_h2]:font-semibold [&_h2]:tracking-wide [&_h2]:text-muted-foreground">
        <ProjectAutomationsSlot
          project={{
            environmentId: summary.root.environmentId,
            rootThreadId: summary.root.id,
            rootProjectId: summary.root.projectId,
          }}
        />
      </div>
    ),
  };

  return (
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
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <UsersIcon className="size-4" />
                  {summary.activeWorkerCount} working
                </span>
                <NeedsYouCount summary={summary} />
                {summary.blocked.length > 0 ? (
                  <span className="text-error">{summary.blocked.length} blocked</span>
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

              <ProjectReleaseLine
                summary={summary}
                runningVersion={
                  serverConfigs.get(summary.root.environmentId)?.environment.serverVersion ?? null
                }
              />
              {/* On every tab, above the tabs: one line until it is used. */}
              <ProjectRequestBox summary={summary} />
              <ProjectTabBar
                tab={tab}
                onSelect={selectTab}
                actions={
                  tab === "dashboard" ? (
                    <Button size="xs" variant="ghost-muted" onClick={() => setCustomizing(true)}>
                      <SlidersHorizontalIcon />
                      Customize
                    </Button>
                  ) : null
                }
              />
              {tab === "roadmap" ? (
                <ProjectRoadmapWidget summary={summary} />
              ) : tab === "issues" ? (
                <ProjectIssuesBoard summary={summary} />
              ) : (
                <ProjectWidgetList
                  summary={summary}
                  views={widgetViews}
                  customizing={customizing}
                  onCustomizingChange={setCustomizing}
                />
              )}
            </WorkspacePageContainer>
          </div>
          {chatOpen ? (
            <aside className="flex w-[400px] min-w-0 shrink-0 flex-col border-l border-border">
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
  );
}
