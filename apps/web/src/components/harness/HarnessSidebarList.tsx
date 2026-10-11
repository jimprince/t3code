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
import { buildOrchestratorSummaries } from "@t3tools/client-runtime/state/orchestrators";
import { partitionThreadPurposes } from "@t3tools/client-runtime/state/thread-purpose";
import { formatLocalWhen } from "@t3tools/shared/localTime";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useHarnessEnvironments } from "../../state/harness";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { useSidebar } from "../ui/sidebar";
import { ProjectQueryState } from "../orchestrators/ProjectQueryState";
import { useOrchestratorThreadShells } from "../orchestrators/useOrchestratorThreads";
import { useSelectedRoute } from "../orchestrators/OrchestratorSidebarList";
import { HarnessCheckDetails } from "./HarnessCheckDetails";

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
const TONE_DOT: Record<HarnessTone, string> = {
  error: "bg-error",
  warning: "bg-warning",
  muted: "bg-muted-foreground/40",
  ok: "bg-success",
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
}: {
  readonly agent: HarnessAgentView;
  readonly now: number;
  readonly selectedRoute: string | null;
  readonly touch: boolean;
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
    </li>
  );
}

function HarnessCheckRow({
  check,
  environmentLabel,
  now,
  expanded,
  touch,
  onToggle,
}: {
  readonly check: HarnessCheckView;
  readonly environmentLabel: string | null;
  readonly now: number;
  readonly expanded: boolean;
  readonly touch: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={check.spokenLabel}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-sidebar-row-hover",
          touch && "min-h-11",
        )}
        onClick={onToggle}
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[check.tone])}
          />
          <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{check.name}</span>
          <span className={cn("shrink-0 text-xs", TONE_TEXT[check.tone])}>
            {check.latenessLabel ?? check.stateLabel}
          </span>
          {expanded ? (
            <ChevronDownIcon
              aria-hidden
              className="size-3.5 shrink-0 text-sidebar-muted-foreground"
            />
          ) : (
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-sidebar-muted-foreground"
            />
          )}
        </span>
        <span className="truncate pl-3.5 text-3xs text-sidebar-muted-foreground">
          {[check.classification, environmentLabel].filter((part) => part).join(" · ")}
        </span>
        <span className="flex min-w-0 gap-2 pl-3.5 text-3xs text-sidebar-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{check.timing}</span>
          <span
            className={cn(
              "shrink-0 tabular-nums",
              check.errors.everyRun ? "text-warning-foreground" : undefined,
            )}
          >
            {check.errorsText}
          </span>
        </span>
      </button>
      {expanded && !touch ? <HarnessCheckDetails check={check} now={now} touch={false} /> : null}
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
  const { isMobile } = useSidebar();
  const { environments, refresh } = useHarnessEnvironments();
  const [idleExpanded, setIdleExpanded] = useState(false);
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);

  const agents = useMemo(() => {
    const summaries = buildOrchestratorSummaries(threads, projects);
    return buildHarnessAgents(partitionThreadPurposes(threads, summaries).harness);
  }, [projects, threads]);
  const attention = agents.filter((agent) => agent.bucket !== "idle");
  const idle = agents.filter((agent) => agent.bucket === "idle");

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
  const { harness: harnessChecks, unclassified } = useMemo(
    () => splitHarnessChecks(checks),
    [checks],
  );
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
  const expanded = checks.find((check) => check.key === expandedCheck) ?? null;
  const renderCheck = (check: HarnessCheckView) => (
    <HarnessCheckRow
      key={check.key}
      check={check}
      environmentLabel={
        environments.length > 1
          ? (labelByEnvironment.get(check.routine.environmentId) ?? null)
          : null
      }
      now={now}
      touch={isMobile}
      expanded={expandedCheck === check.key}
      onToggle={() => setExpandedCheck((key) => (key === check.key ? null : check.key))}
    />
  );

  return (
    <div className="flex flex-col gap-1">
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
                  />
                ))
              : null}
          </ul>
        )}
      </section>

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
        <ul className="flex flex-col gap-px">{harnessChecks.map(renderCheck)}</ul>
        {unclassified.length > 0 ? (
          <>
            <SectionHeading title="Unclassified" detail="no owner, not Harness" />
            <ul className="flex flex-col gap-px">{unclassified.map(renderCheck)}</ul>
          </>
        ) : null}
      </section>

      {isMobile ? (
        <Sheet
          open={expanded !== null}
          onOpenChange={(open) => {
            if (!open) setExpandedCheck(null);
          }}
        >
          <SheetPopup side="bottom" className="max-h-[80vh]">
            {expanded ? (
              <>
                <SheetHeader>
                  <SheetTitle>{expanded.name}</SheetTitle>
                </SheetHeader>
                <div className="min-h-0 overflow-y-auto pb-4">
                  <HarnessCheckDetails check={expanded} now={now} touch />
                </div>
              </>
            ) : null}
          </SheetPopup>
        </Sheet>
      ) : null}
    </div>
  );
}
