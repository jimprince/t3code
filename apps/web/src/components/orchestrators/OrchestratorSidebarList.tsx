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
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, UsersIcon } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readEnvironmentSupportsPinReorder, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { toastManager } from "../ui/toast";
import { OrchestratorStatus } from "./OrchestratorStatus";
import { useDeferredProjectSidebarBuckets } from "./projectSidebarOrder";
import { planProjectMove } from "./projectSidebarMove.logic";
import {
  COLLAPSED_SUBPROJECTS_KEY,
  openTaskCount,
  ownTreeContains,
  projectKeyOf,
  subprojectCountLabel,
  subprojectIsActive,
  subprojectWorkingLabel,
  toggleProjectKey,
} from "./projectSubprojects.logic";
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
const NO_PROJECTS: ReadonlyArray<string> = [];
const ProjectKeys = Schema.Array(Schema.String);
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

/** Subprojects of a project in sidebar order, supplied by the list so every level shares the deferred buckets. */
type SortSubprojects = (summary: OrchestratorSummary) => ReadonlyArray<OrchestratorSummary>;

/** One compact "/ Name" line per subproject, beneath its parent's card; deeper levels indent. */
function SubprojectRows({
  summary,
  selectedRoute,
  sortSubprojects,
  depth = 0,
}: {
  readonly summary: OrchestratorSummary;
  readonly selectedRoute: string | null;
  readonly sortSubprojects: SortSubprojects;
  readonly depth?: number;
}) {
  const navigate = useNavigate();
  return sortSubprojects(summary).map((sub) => {
    const { rollup } = sub;
    const selected = ownTreeContains(sub, selectedRoute);
    return (
      <div key={projectKeyOf(sub)}>
        <button
          type="button"
          aria-label={`Open ${sub.root.title} subproject`}
          aria-current={selected ? "page" : undefined}
          style={{ paddingLeft: `${0.625 + depth * 0.75}rem` }}
          className={`pointer-events-auto flex h-6 w-full cursor-pointer items-center gap-1.5 rounded pr-1.5 text-left text-3xs hover:bg-sidebar-row-hover ${
            selected
              ? "bg-sidebar-row-active text-sidebar-foreground"
              : "text-sidebar-muted-foreground"
          }`}
          onClick={() =>
            void navigate({
              to: "/orchestrators/$environmentId/$threadId",
              params: { environmentId: sub.root.environmentId, threadId: sub.root.id },
            })
          }
        >
          <span aria-hidden>/</span>
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${
              rollup.needsYou > 0
                ? "bg-warning"
                : subprojectIsActive(sub)
                  ? "bg-info"
                  : "bg-muted-foreground/40"
            }`}
          />
          <span className="min-w-0 flex-1 truncate">{sub.root.title}</span>
          {rollup.blocked > 0 ? <span className="shrink-0 text-error">Blocked</span> : null}
          {rollup.needsYou > 0 ? (
            <span className="shrink-0 tabular-nums text-warning-foreground">{rollup.needsYou}</span>
          ) : null}
          <span className="shrink-0 tabular-nums">
            {formatRelativeTimeLabel(rollup.latestActivityAt)}
          </span>
        </button>
        <SubprojectRows
          summary={sub}
          selectedRoute={selectedRoute}
          sortSubprojects={sortSubprojects}
          depth={depth + 1}
        />
      </div>
    );
  });
}

/** What a draggable row needs from dnd-kit, plus Alt+Up/Down for the keyboard. */
interface ProjectRowArrange {
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly listeners: ReturnType<typeof useSortable>["listeners"];
  readonly style: CSSProperties;
  readonly isDragging: boolean;
  readonly onMove: (direction: -1 | 1) => void;
}

function ProjectRow({
  summary,
  selectedRoute,
  sortSubprojects,
  collapsed,
  onToggleSubprojects,
  arrange,
}: {
  readonly summary: OrchestratorSummary;
  readonly selectedRoute: string | null;
  readonly sortSubprojects: SortSubprojects;
  readonly collapsed: boolean;
  readonly onToggleSubprojects: (projectKey: string) => void;
  readonly arrange?: ProjectRowArrange | undefined;
}) {
  const navigate = useNavigate();
  const selected = ownTreeContains(summary, selectedRoute);
  const openIssues = openTaskCount(summary);
  const { rollup } = summary;
  const hasSubprojects = summary.subprojects.length > 0;
  const workingInSubprojects = subprojectWorkingLabel(summary);
  const foldedHint = subprojectCountLabel(summary);
  const rootRef = scopeThreadRef(summary.root.environmentId, summary.root.id);
  const rootProject =
    summary.projects.find(
      (project) =>
        project.environmentId === summary.root.environmentId &&
        project.id === summary.root.projectId,
    ) ?? summary.projects[0];
  // The project's own orchestrator thread owns the row, so it takes the same
  // right-click menu every other thread row has: pin order, settle, nest,
  // archive. Rename is left out; this row has no inline title editor.
  const { openMenu } = useThreadActionMenu({
    threadRef: rootRef,
    projectCwd: rootProject?.workspaceRoot ?? null,
    onStartRename: null,
  });
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [openMenu],
  );
  const onMove = arrange?.onMove;
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (!onMove || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      onMove(event.key === "ArrowUp" ? -1 : 1);
    },
    [onMove],
  );
  return (
    <li
      ref={arrange?.setNodeRef}
      style={arrange?.style}
      {...arrange?.listeners}
      className={`relative rounded-md ${
        arrange?.isDragging
          ? "z-20 bg-sidebar-row-hover shadow-md"
          : selected
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "hover:bg-sidebar-row-hover"
      }`}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        aria-label={`Open ${summary.root.title} project`}
        aria-current={selected ? "page" : undefined}
        aria-keyshortcuts={arrange ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        className="absolute inset-0 z-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        onKeyDown={handleKeyDown}
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
              {openIssues} {openIssues === 1 ? "task" : "tasks"}
            </span>
          ) : null}
          {hasSubprojects ? (
            <button
              type="button"
              aria-label={`${collapsed ? "Show" : "Hide"} subprojects of ${summary.root.title}`}
              aria-expanded={!collapsed}
              className="pointer-events-auto -mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              onClick={() => onToggleSubprojects(projectKeyOf(summary))}
            >
              {collapsed ? (
                <ChevronRightIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </button>
          ) : null}
        </span>
        <span className="flex min-w-0 w-full items-center gap-2 text-xs">
          <OrchestratorStatus status={summary.status} />
          <span className="ml-auto inline-flex items-center gap-2 text-sidebar-muted-foreground">
            {rollup.needsYou > 0 ? (
              <span className="inline-flex items-center gap-1 text-warning-foreground">
                <CircleAlertIcon className="size-3.5" />
                {rollup.needsYou}
              </span>
            ) : null}
            {rollup.working > 0 ? (
              <span className="inline-flex items-center gap-1">
                <UsersIcon className="size-3.5" />
                {rollup.working} working
              </span>
            ) : null}
            <span>{formatRelativeTimeLabel(rollup.latestActivityAt)}</span>
          </span>
        </span>
        <span className="truncate text-3xs text-sidebar-muted-foreground">
          {[
            ...summary.projects.map((project) => project.title),
            // A folded card keeps a count of the rows it hides.
            ...(collapsed && foldedHint !== null ? [foldedHint] : []),
          ].join(" · ")}
        </span>
        {workingInSubprojects ? (
          <span className="truncate text-3xs text-sidebar-muted-foreground">
            {workingInSubprojects}
          </span>
        ) : null}
        {hasSubprojects && !collapsed ? (
          <div className="-mx-1 border-t border-sidebar-border pt-1">
            <SubprojectRows
              summary={summary}
              selectedRoute={selectedRoute}
              sortSubprojects={sortSubprojects}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** A Projects row that can be dragged, or moved with Alt+Up/Down, to rearrange the list. */
function SortableProjectRow({
  id,
  disabled,
  reducedMotion,
  onMove,
  ...row
}: Omit<Parameters<typeof ProjectRow>[0], "arrange"> & {
  readonly id: string;
  readonly disabled: boolean;
  readonly reducedMotion: boolean;
  readonly onMove: (key: string, direction: -1 | 1) => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const arrange = useMemo(
    (): ProjectRowArrange => ({
      setNodeRef,
      listeners,
      style: {
        transform: CSS.Translate.toString(transform),
        // Neighbours slide aside while dragging; with reduced motion they jump.
        transition: reducedMotion ? undefined : transition,
      },
      isDragging,
      onMove: (direction) => onMove(id, direction),
    }),
    [id, isDragging, listeners, onMove, reducedMotion, setNodeRef, transform, transition],
  );
  return <ProjectRow {...row} arrange={disabled ? undefined : arrange} />;
}

export function OrchestratorSidebarList() {
  const projects = useProjects();
  const threads = useOrchestratorThreadShells();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const selectedRoute = useSelectedRoute();
  const [quietExpanded, setQuietExpanded] = useState(false);
  // Projects whose subprojects this device has folded away; the rest show theirs.
  const [collapsedProjects, setCollapsedProjects] = useLocalStorage(
    COLLAPSED_SUBPROJECTS_KEY,
    NO_PROJECTS,
    ProjectKeys,
  );
  const toggleSubprojects = useCallback(
    (projectKey: string) =>
      setCollapsedProjects((current) => toggleProjectKey(current, projectKey)),
    [setCollapsedProjects],
  );
  const [quietCutoff] = useState(() => Date.now() - QUIET_AFTER_MS);
  // Every project, subprojects included: each carries its own sidebar bucket.
  const allSummaries = useMemo(
    () => buildOrchestratorSummaries(threads, projects),
    [projects, threads],
  );
  const summaries = useMemo(
    () => allSummaries.filter((summary) => summary.parentProjectKey === null),
    [allSummaries],
  );
  const standaloneGroups = useMemo(
    () => buildStandaloneThreadGroups(threads, projects, lastVisitedAtByThreadKey),
    [lastVisitedAtByThreadKey, projects, threads],
  );
  const desiredBuckets = useMemo(
    () => [
      ...allSummaries.map(
        (summary) => [threadKey(summary.root), projectSidebarBucket(summary, quietCutoff)] as const,
      ),
      ...standaloneGroups.flatMap((group) =>
        group.threads.map(
          ({ thread, status }) => [threadKey(thread), STANDALONE_BUCKET[status]] as const,
        ),
      ),
    ],
    [allSummaries, quietCutoff, standaloneGroups],
  );
  const displayedBuckets = useDeferredProjectSidebarBuckets(desiredBuckets);
  const orderedSummaries = useMemo(
    () => sortOrchestratorSummariesForSidebar(summaries, quietCutoff, displayedBuckets),
    [displayedBuckets, quietCutoff, summaries],
  );
  const sortSubprojects = useCallback(
    (summary: OrchestratorSummary) =>
      sortOrchestratorSummariesForSidebar(summary.subprojects, quietCutoff, displayedBuckets),
    [displayedBuckets, quietCutoff],
  );
  const active = orderedSummaries.filter(
    (summary) => displayedBuckets.get(threadKey(summary.root)) !== "quiet",
  );
  const quiet = orderedSummaries.filter(
    (summary) => displayedBuckets.get(threadKey(summary.root)) === "quiet",
  );
  // A move shows its order at once and holds it until the server's pins land,
  // or the list's membership changes under it (a failed move drops it too).
  const [pendingMove, setPendingMove] = useState<{
    readonly order: ReadonlyArray<string>;
    readonly assigned: ReadonlyMap<string, string>;
  } | null>(null);
  const pinKeyByThread = new Map(
    active.map((summary) => [
      threadKey(summary.root),
      summary.root.pinnedAt != null ? (summary.root.pinOrderKey ?? null) : null,
    ]),
  );
  const holdingMove =
    pendingMove !== null &&
    pinKeyByThread.size === pendingMove.order.length &&
    pendingMove.order.every((key) => pinKeyByThread.has(key)) &&
    ![...pendingMove.assigned].every(([key, orderKey]) => pinKeyByThread.get(key) === orderKey);
  if (pendingMove !== null && !holdingMove) setPendingMove(null);
  const arranged = holdingMove
    ? [...active].sort(
        (left, right) =>
          pendingMove.order.indexOf(threadKey(left.root)) -
          pendingMove.order.indexOf(threadKey(right.root)),
      )
    : active;
  const { pinThread, reorderPinnedThread } = useThreadActions();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  /** Moves a project to `toIndex` of the shown list by pinning it, and any project above it, in order. */
  const moveProject = (movedKey: string, toIndex: number) => {
    const byKey = new Map(arranged.map((summary) => [threadKey(summary.root), summary]));
    const plan = planProjectMove({
      rows: arranged.map((summary) => ({
        key: threadKey(summary.root),
        pinned: summary.root.pinnedAt != null,
        pinOrderKey: summary.root.pinOrderKey ?? null,
      })),
      movedKey,
      toIndex,
      reservedKeys: quiet.flatMap((summary) =>
        summary.root.pinnedAt != null && summary.root.pinOrderKey != null
          ? [summary.root.pinOrderKey]
          : [],
      ),
    });
    if (plan.writes.length === 0) return;
    const writes = plan.writes.map((write) => {
      const root = byKey.get(write.key)!.root;
      return { ...write, ref: scopeThreadRef(root.environmentId, root.id) };
    });
    if (writes.some((write) => !readEnvironmentSupportsPinReorder(write.ref.environmentId))) {
      toastManager.add({ type: "error", title: "Update this server to arrange projects" });
      return;
    }
    setPendingMove({
      order: plan.order,
      assigned: new Map(writes.map((write) => [write.key, write.orderKey])),
    });
    void Promise.all(
      writes.map((write) =>
        write.kind === "pin"
          ? pinThread(write.ref, { orderKey: write.orderKey })
          : reorderPinnedThread(write.ref, write.orderKey),
      ),
    ).then((results) => {
      if (results.every((result) => result._tag === "Success")) return;
      setPendingMove(null);
      toastManager.add({ type: "error", title: "Could not move the project" });
    });
  };
  const moveProjectBy = (key: string, direction: -1 | 1) => {
    const index = arranged.findIndex((summary) => threadKey(summary.root) === key);
    if (index !== -1) moveProject(key, index + direction);
  };
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  // The pointer is released over the row it dragged, so swallow that one click.
  const justDragged = useRef(false);
  const handleDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    if (!over) return;
    const toIndex = arranged.findIndex((summary) => threadKey(summary.root) === over.id);
    if (toIndex !== -1) moveProject(String(dragged.id), toIndex);
  };
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
          <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={arranged.map((summary) => threadKey(summary.root))}
              strategy={verticalListSortingStrategy}
            >
              <ul
                aria-label="Projects"
                className="flex flex-col gap-px"
                onClickCapture={(event) => {
                  if (!justDragged.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                {arranged.map((summary) => (
                  <SortableProjectRow
                    key={threadKey(summary.root)}
                    id={threadKey(summary.root)}
                    disabled={!readEnvironmentSupportsPinReorder(summary.root.environmentId)}
                    reducedMotion={reducedMotion}
                    onMove={moveProjectBy}
                    summary={summary}
                    selectedRoute={selectedRoute}
                    sortSubprojects={sortSubprojects}
                    collapsed={collapsedProjects.includes(projectKeyOf(summary))}
                    onToggleSubprojects={toggleSubprojects}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
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
                      selectedRoute={selectedRoute}
                      sortSubprojects={sortSubprojects}
                      collapsed={collapsedProjects.includes(projectKeyOf(summary))}
                      onToggleSubprojects={toggleSubprojects}
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
