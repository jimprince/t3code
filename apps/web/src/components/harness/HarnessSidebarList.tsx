import { selectHarnessQueuedSends } from "@t3tools/client-runtime/state/harness-query";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildHarnessAgents,
  buildHarnessChecks,
  describeHarnessAgent,
  describeHarnessFreshness,
  describeHarnessSources,
  spokenHarnessAgent,
  splitHarnessChecks,
  type HarnessAgentBucket,
  type HarnessAgentView,
  type HarnessCheckView,
  type HarnessTone,
} from "@t3tools/client-runtime/state/harness-view";
import { harnessCheckRef } from "@t3tools/client-runtime/state/harness-check-page";
import {
  buildHarnessChecksList,
  harnessOwnerTitles,
} from "@t3tools/client-runtime/state/harness-checks-list";
import { buildHarnessStrip } from "@t3tools/client-runtime/state/harness-strip";
import {
  groupSubheadsByOwner,
  type SubheadGroup as SubheadGroupView,
} from "@t3tools/client-runtime/state/subheads-view";
import { buildOrchestratorSummaries } from "@t3tools/client-runtime/state/orchestrators";
import { partitionThreadPurposes } from "@t3tools/client-runtime/state/thread-purpose";
import type { ThreadId } from "@t3tools/contracts";
import { formatLocalWhen } from "@t3tools/shared/localTime";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, PinIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useHarnessEnvironments } from "../../state/harness";
import { useSubheadEnvironments } from "../../state/subheads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSidebar } from "../ui/sidebar";
import { ProjectQueryState } from "../orchestrators/ProjectQueryState";
import { useOrchestratorThreadShells } from "../orchestrators/useOrchestratorThreads";
import { useSelectedRoute } from "../orchestrators/OrchestratorSidebarList";
import { SubheadGroup, type SubheadThreadLookup } from "./SubheadRows";
import { TONE_DOT } from "./harnessTone";
import { useHarnessCheckPin } from "./useHarnessCheckPin";

const DOT: Record<HarnessAgentBucket, string> = {
  failed: "bg-error",
  "needs-you": "bg-warning",
  working: "bg-info",
  idle: "bg-muted-foreground/40",
};
const AGENT_TONE = {
  error: "text-error",
  warning: "text-warning-foreground",
  info: "text-info-foreground",
} as const;
const TONE_TEXT: Record<HarnessTone, string> = {
  error: "text-error",
  warning: "text-warning-foreground",
  muted: "text-sidebar-muted-foreground",
  ok: "text-success-foreground",
};

function SectionHeading({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string | null;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 px-2.5 pt-2 pb-1">
      <h2 className="text-3xs font-semibold tracking-wide text-sidebar-muted-foreground uppercase">
        {title}
      </h2>
      {children}
      {detail ? (
        <span className="ml-auto text-3xs text-sidebar-muted-foreground">{detail}</span>
      ) : null}
    </div>
  );
}

function HarnessAgentRow({
  agent,
  now,
  selectedRoute,
  touch,
  subheads,
  selectedSubhead,
  lookup,
  threadExists,
}: {
  readonly agent: HarnessAgentView;
  readonly now: number;
  readonly selectedRoute: string | null;
  readonly touch: boolean;
  /** The subheads this head owns, or undefined when it has none. */
  readonly subheads: SubheadGroupView | undefined;
  readonly selectedSubhead: string | null;
  readonly lookup: SubheadThreadLookup;
  readonly threadExists: (environmentId: string, threadId: ThreadId) => boolean;
}) {
  const navigate = useNavigate();
  const { thread } = agent;
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const projects = useProjects();
  const cwd =
    projects.find(
      (project) =>
        project.environmentId === thread.environmentId && project.id === thread.projectId,
    )?.workspaceRoot ?? null;
  // The root's own thread menu: Move back to Projects or Threads, pin, settle, archive.
  const { openMenu } = useThreadActionMenu({
    threadRef: ref,
    projectCwd: cwd,
    onStartRename: null,
  });
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [openMenu],
  );
  const selected = selectedRoute === agent.key;
  const right = describeHarnessAgent(agent);
  const open = () =>
    void (agent.summary
      ? navigate({
          to: "/orchestrators/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        })
      : navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }));
  return (
    <li onContextMenu={handleContextMenu}>
      <button
        type="button"
        aria-label={spokenHarnessAgent(agent)}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm hover:bg-sidebar-row-hover",
          touch ? "min-h-11" : "h-8",
          selected && "bg-sidebar-row-active text-sidebar-foreground",
        )}
        onClick={open}
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[agent.bucket])} />
        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{thread.title}</span>
        {right ? (
          <span className={cn("shrink-0 text-xs", AGENT_TONE[right.tone])}>{right.text}</span>
        ) : null}
        <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
          {formatLocalWhen(Date.parse(agent.latestActivityAt), now)}
        </span>
      </button>
      {subheads ? (
        <SubheadGroup
          group={subheads}
          now={now}
          touch={touch}
          selectedSubhead={selectedSubhead}
          lookup={lookup}
          threadExists={threadExists}
        />
      ) : null}
    </li>
  );
}

/** The check open in the main pane, as `<environmentId>:<checkKey>`, or null on any other page. */
function useSelectedCheck() {
  return useParams({
    strict: false,
    select: (params: { environmentId?: string; checkKey?: string }) =>
      params.environmentId && params.checkKey
        ? { environmentId: params.environmentId, checkKey: params.checkKey }
        : null,
  });
}

/** The subhead open in the main pane, as `<environmentId>:<name>`, or null on any other page. */
function useSelectedSubhead() {
  return useParams({
    strict: false,
    select: (params: { environmentId?: string; name?: string }) =>
      params.environmentId && params.name ? `${params.environmentId}:${params.name}` : null,
  });
}

/** One check: a compact row that opens the check's own page in the main pane. */
function HarnessCheckRow({
  check,
  environmentLabel,
  selected,
  touch,
  onOpen,
  onMenu,
}: {
  readonly check: HarnessCheckView;
  readonly environmentLabel: string | null;
  readonly selected: boolean;
  readonly touch: boolean;
  readonly onOpen: (check: HarnessCheckView) => void;
  readonly onMenu: (check: HarnessCheckView, position: { x: number; y: number }) => void;
}) {
  return (
    <li
      onContextMenu={(event) => {
        // Hidden entirely on a server that cannot pin: there is nothing else to offer.
        if (!check.pinSupported) return;
        event.preventDefault();
        onMenu(check, { x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        aria-label={check.spokenLabel}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-sidebar-row-hover",
          touch && "min-h-11",
          selected && "bg-sidebar-row-active",
        )}
        onClick={() => onOpen(check)}
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[check.tone])}
          />
          <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{check.name}</span>
          {check.pinned ? (
            <PinIcon aria-hidden className="size-3 shrink-0 text-sidebar-muted-foreground" />
          ) : null}
          <span className={cn("shrink-0 text-xs", TONE_TEXT[check.tone])}>
            {check.latenessLabel ?? check.stateLabel}
          </span>
        </span>
        <span className="truncate pl-3.5 text-3xs text-sidebar-muted-foreground">
          {[check.classification, environmentLabel].filter((part) => part).join(" · ")}
        </span>
        <span className="flex min-w-0 gap-2 pl-3.5 text-3xs text-sidebar-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{check.timing}</span>
          {check.errorsText === null ? null : (
            <span
              className={cn(
                "shrink-0 tabular-nums",
                check.errors.everyRun ? "text-warning-foreground" : undefined,
              )}
            >
              {check.errorsText}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * The Harness tab: the roots that improve the tools, then the automated checks they run, each
 * with its schedule, lateness and findings so a check that stopped running, or one that keeps
 * catching errors, is visible without opening anything.
 */
export function HarnessSidebarList() {
  const projects = useProjects();
  const threads = useOrchestratorThreadShells();
  const selectedRoute = useSelectedRoute();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const selectedCheck = useSelectedCheck();
  const { environments, refresh } = useHarnessEnvironments();
  const [idleExpanded, setIdleExpanded] = useState(false);

  const agents = useMemo(() => {
    const summaries = buildOrchestratorSummaries(threads, projects);
    return buildHarnessAgents(partitionThreadPurposes(threads, summaries).harness);
  }, [projects, threads]);
  // Subheads group under the head that owns them, whichever environment serves them.
  const subheadEnvironments = useSubheadEnvironments();
  const subheadGroups = useMemo(() => {
    const groups = new Map<string, SubheadGroupView>();
    for (const environment of subheadEnvironments) {
      for (const [owner, group] of groupSubheadsByOwner(environment.rows))
        groups.set(`${environment.environmentId}:${owner}`, group);
    }
    return groups;
  }, [subheadEnvironments]);
  const selectedSubhead = useSelectedSubhead();
  const threadTitles = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.title])),
    [threads],
  );
  const lookup = useMemo<SubheadThreadLookup>(
    () => ({ title: (environmentId, id) => threadTitles.get(`${environmentId}:${id}`) ?? null }),
    [threadTitles],
  );
  const threadExists = useCallback(
    (environmentId: string, id: ThreadId) => threadTitles.has(`${environmentId}:${id}`),
    [threadTitles],
  );
  const groupOf = (agent: HarnessAgentView) =>
    subheadGroups.get(`${agent.thread.environmentId}:${agent.thread.id}`);
  // A quiet head still shows when its subheads have open work or a failure to look at.
  const needsAttention = (agent: HarnessAgentView) => {
    const group = groupOf(agent);
    return (
      agent.bucket !== "idle" ||
      (group?.visible.some((row) => row.openRuns.length > 0 || row.lastTone === "error") ?? false)
    );
  };
  const attention = agents.filter(needsAttention);
  const idle = agents.filter((agent) => !needsAttention(agent));
  // Subheads whose owning head is not a Harness agent here still need a place to show.
  const ownedGroups = useMemo(() => new Set(agents.map((agent) => `${agent.thread.environmentId}:${agent.thread.id}`)), [agents]);
  const orphanGroups = [...subheadGroups].filter(([key]) => !ownedGroups.has(key));

  const snapshots = useMemo(
    () => environments.flatMap(({ snapshot }) => (snapshot === null ? [] : [snapshot])),
    [environments],
  );
  // The minute clock keeps "late" and "stale" current even when polling has stopped.
  const nowMinute = useNowMinute();
  const now = useMemo(() => Date.parse(`${nowMinute}:00Z`), [nowMinute]);
  // A host whose last refresh failed can no longer confirm its rows, however recent they are.
  const unreachable = useMemo(
    () =>
      new Set<string>(
        environments
          .filter((environment) => environment.error !== null)
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const checks = useMemo(
    () => buildHarnessChecks(snapshots, now, { unreachable }),
    [now, snapshots, unreachable],
  );
  const strip = useMemo(
    () =>
      buildHarnessStrip({
        snapshots,
        queuedSends: selectHarnessQueuedSends(snapshots),
        now,
        unreachable,
        missingEnvironments: environments.filter((environment) => environment.snapshot === null)
          .length,
      }),
    [environments, now, snapshots, unreachable],
  );
  // The header counts every Harness check, whatever the filter shows.
  const harnessChecks = useMemo(() => splitHarnessChecks(checks).harness, [checks]);
  const [query, setQuery] = useState("");
  const [feedsExpanded, setFeedsExpanded] = useState(false);
  const ownerTitle = useMemo(() => harnessOwnerTitles(threads), [threads]);
  const list = useMemo(
    () => buildHarnessChecksList(checks, query, ownerTitle),
    [checks, ownerTitle, query],
  );
  const showFeeds = feedsExpanded || list.feedsOpen;
  const labelByEnvironment = useMemo(
    () => new Map(environments.map(({ environmentId, label }) => [environmentId, label])),
    [environments],
  );
  const oldest = snapshots.map((snapshot) => snapshot.generatedAt).sort()[0];
  const freshness = describeHarnessFreshness(oldest ?? null, now);
  const problemCount = (state: HarnessCheckView["state"]) =>
    harnessChecks.filter((check) => check.state === state).length;
  const summaryParts = [
    problemCount("failing") > 0 ? `${problemCount("failing")} failing` : null,
    problemCount("overdue") > 0 ? `${problemCount("overdue")} overdue` : null,
    ...describeHarnessSources(snapshots),
  ].filter((part) => part !== null);
  // A phone's drawer closes so the check's page shows.
  const { openMenu: openPinMenu } = useHarnessCheckPin();
  const openCheck = useCallback(
    (check: HarnessCheckView) => {
      void navigate({
        to: "/harness/checks/$environmentId/$checkKey",
        params: harnessCheckRef(check),
      });
      if (isMobile) setOpenMobile(false);
    },
    [isMobile, navigate, setOpenMobile],
  );
  const renderCheck = (check: HarnessCheckView) => (
    <HarnessCheckRow
      key={check.key}
      check={check}
      environmentLabel={
        environments.length > 1
          ? (labelByEnvironment.get(check.routine.environmentId) ?? null)
          : null
      }
      selected={
        selectedCheck?.environmentId === check.routine.environmentId &&
        selectedCheck.checkKey === check.key
      }
      touch={isMobile}
      onOpen={openCheck}
      onMenu={openPinMenu}
    />
  );

  return (
    <div className="flex flex-col gap-1">
      <p
        className={cn(
          "flex flex-wrap gap-x-2 border-b border-sidebar-border px-2.5 pb-1.5 text-xs text-sidebar-muted-foreground",
          strip.stale && "opacity-60",
        )}
      >
        {strip.parts.map((part, index) => (
          <span key={part.label}>
            {index > 0 ? <span aria-hidden>· </span> : null}
            {part.label}{" "}
            <span
              className={part.tone === "muted" ? "text-sidebar-foreground" : TONE_TEXT[part.tone]}
            >
              {part.value}
            </span>
          </span>
        ))}
        {strip.stale ? <span className="text-warning-foreground">· stale</span> : null}
      </p>
      <section aria-label="Harness agents">
        <SectionHeading
          title="Agents"
          detail={agents.length === 0 ? null : `${attention.length} of ${agents.length} active`}
        />
        {agents.length === 0 ? (
          <p className="px-3 py-2 text-xs text-sidebar-muted-foreground">
            Move a thread here from its menu to track it as Harness.
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {attention.map((agent) => (
              <HarnessAgentRow
                key={agent.key}
                agent={agent}
                now={now}
                selectedRoute={selectedRoute}
                touch={isMobile}
                subheads={groupOf(agent)}
                selectedSubhead={selectedSubhead}
                lookup={lookup}
                threadExists={threadExists}
              />
            ))}
            {idle.length > 0 ? (
              <li>
                <button
                  type="button"
                  aria-expanded={idleExpanded}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1 px-2.5 text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground",
                    isMobile ? "min-h-11" : "h-7",
                  )}
                  onClick={() => setIdleExpanded((value) => !value)}
                >
                  {idleExpanded ? (
                    <ChevronDownIcon aria-hidden className="size-3.5" />
                  ) : (
                    <ChevronRightIcon aria-hidden className="size-3.5" />
                  )}
                  {idleExpanded ? "Hide" : "Show"} {idle.length} idle
                </button>
              </li>
            ) : null}
            {idleExpanded
              ? idle.map((agent) => (
                  <HarnessAgentRow
                    key={agent.key}
                    agent={agent}
                    now={now}
                    selectedRoute={selectedRoute}
                    touch={isMobile}
                    subheads={groupOf(agent)}
                    selectedSubhead={selectedSubhead}
                    lookup={lookup}
                    threadExists={threadExists}
                  />
                ))
              : null}
          </ul>
        )}
      </section>

      {orphanGroups.length > 0 ? (
        <section aria-label="Subheads of other heads">
          <SectionHeading title="Other subheads" detail="owner is not a Harness agent" />
          {orphanGroups.map(([key, group]) => {
            const owner = threadTitles.get(key);
            return (
              <div key={key}>
                <p className="px-2.5 pt-1 text-3xs text-sidebar-muted-foreground">
                  {owner ?? "Head not listed here"}
                </p>
                <SubheadGroup
                  group={group}
                  now={now}
                  touch={isMobile}
                  selectedSubhead={selectedSubhead}
                  lookup={lookup}
                  threadExists={threadExists}
                />
              </div>
            );
          })}
        </section>
      ) : null}

      <section aria-label="Harness checks">
        <SectionHeading title="Checks" detail={summaryParts.join(" · ") || null}>
          {oldest === undefined ? null : (
            <button
              type="button"
              className={cn(
                "text-3xs hover:underline",
                freshness.stale ? "text-warning-foreground" : "text-sidebar-muted-foreground",
              )}
              aria-label="Read the checks again"
              onClick={refresh}
            >
              {freshness.stale ? `stale, ${freshness.label}` : freshness.label}
            </button>
          )}
        </SectionHeading>
        {environments.length === 0 ? (
          <p className="px-3 py-2 text-xs text-sidebar-muted-foreground">
            No connected server reports Harness checks yet.
          </p>
        ) : null}
        {environments.map((environment) =>
          environment.snapshot === null && (environment.error !== null || environment.isPending) ? (
            <div key={environment.environmentId} className="px-2.5 py-1">
              <ProjectQueryState
                what={`checks on ${environment.label}`}
                error={environment.error}
                onRetry={refresh}
              />
            </div>
          ) : environment.error !== null ? (
            <div key={environment.environmentId} className="px-2.5 py-1">
              <ProjectQueryState
                inline
                what={`checks on ${environment.label}, showing the last read`}
                error={environment.error}
                onRetry={refresh}
              />
            </div>
          ) : null,
        )}
        {checks.length === 0 && snapshots.length > 0 ? (
          <p className="px-3 py-2 text-xs text-sidebar-muted-foreground">
            No automated checks are registered.
          </p>
        ) : null}
        {snapshots.length > 0 ? (
          <div className="flex items-center gap-1 px-2.5 pb-1">
            <Input
              type="search"
              size="compact"
              aria-label="Filter checks"
              placeholder="Filter checks"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query !== "" ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Clear the check filter"
                onClick={() => setQuery("")}
              >
                <XIcon aria-hidden />
              </Button>
            ) : null}
          </div>
        ) : null}
        {list.noMatches ? (
          <p role="status" className="px-3 py-2 text-xs text-sidebar-muted-foreground">
            No checks match.
          </p>
        ) : null}
        <ul className="flex flex-col gap-px">{list.checks.map(renderCheck)}</ul>
        {list.feeds ? (
          <>
            <button
              type="button"
              aria-expanded={showFeeds}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1 px-2.5 text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground",
                isMobile ? "min-h-11" : "h-7",
              )}
              onClick={() => setFeedsExpanded((value) => !value)}
            >
              {showFeeds ? (
                <ChevronDownIcon aria-hidden className="size-3.5" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3.5" />
              )}
              {list.feeds.label}
            </button>
            {showFeeds ? (
              <ul className="flex flex-col gap-px">{list.feeds.checks.map(renderCheck)}</ul>
            ) : null}
          </>
        ) : null}
        {list.unclassified.length > 0 ? (
          <>
            <SectionHeading title="Unclassified" detail="no owner, not Harness" />
            <ul className="flex flex-col gap-px">{list.unclassified.map(renderCheck)}</ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
