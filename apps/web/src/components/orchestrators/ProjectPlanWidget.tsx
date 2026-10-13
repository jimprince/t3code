import type {
  OrchestratorSummary,
  OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { ProjectDecisionFeed, useDecisionFeedCount } from "./ProjectDecisionFeed";
import { useTaskStatuses } from "./ProjectRequestsSection";
import { ProjectSection } from "./ProjectSection";
import { TaskTitle } from "./TaskLink";
import { useWorkstreamBands } from "./WorkstreamBands";
import {
  derivePlanWorkstreams,
  parseUtilityTitles,
  percent,
  PLAN_WINDOW_LABEL,
  planTotals,
  planWindowStart,
  type PlanTask,
  type PlanWindow,
  type PlanWorkstream,
} from "./planProgress.logic";

const PlanWindowSchema = Schema.Literals(["hour", "4h", "today"]);
const WINDOWS: ReadonlyArray<PlanWindow> = ["hour", "4h", "today"];
/** Open tasks listed under a workstream before "N more". */
const TASKS_SHOWN = 6;
const RECENT_SHOWN = 8;

/** A task finished since Brad's last visit, for the list at the end. */
interface RecentDone {
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly closedAt: string;
  readonly where: string;
}

/** What one project tells the widget's header and Done list. */
interface PlanReport {
  readonly doneInWindow: number;
  readonly stalled: number;
  readonly recent: ReadonlyArray<RecentDone>;
}

/** "in 1h": how far one more window reaches. */
function aheadLabel(windowMs: number) {
  const hours = Math.max(1, Math.round(windowMs / (60 * 60 * 1000)));
  return `in ${hours}h`;
}

/**
 * A progress bar: done before the window, then what finished inside it (brightest),
 * then where the window's pace takes it next (hatched). Stalled work shows amber.
 */
function PlanBar({
  fraction,
  gained,
  projected,
  stalled,
  thin = false,
}: {
  readonly fraction: number;
  readonly gained: number;
  readonly projected: number;
  readonly stalled: boolean;
  readonly thin?: boolean;
}) {
  const before = Math.max(0, fraction - gained);
  return (
    <span
      aria-hidden
      className={`flex min-w-16 flex-1 overflow-hidden rounded-full bg-muted ${thin ? "h-1" : "h-1.5"}`}
    >
      <span
        className={stalled ? "bg-warning/80" : "bg-info/55"}
        style={{ width: `${before * 100}%` }}
      />
      <span className="bg-info" style={{ width: `${gained * 100}%` }} />
      <span
        className="text-info/45"
        style={{
          width: `${projected * 100}%`,
          backgroundImage:
            "repeating-linear-gradient(135deg, currentColor 0 3px, transparent 3px 6px)",
        }}
      />
    </span>
  );
}

/** "58% +12 · ~70% in 1h", or why it is not moving. */
function ProgressLabel({
  fraction,
  gained,
  projected,
  stalled,
  windowMs,
}: {
  readonly fraction: number;
  readonly gained: number;
  readonly projected: number;
  readonly stalled: boolean;
  readonly windowMs: number;
}) {
  return (
    <span className="shrink-0 text-xs tabular-nums">
      <span className={stalled ? "text-warning-foreground" : "text-foreground/90"}>
        {percent(fraction)}%
      </span>
      {gained > 0 ? <span className="ml-1 text-info">+{percent(gained)}</span> : null}
      {projected > 0 ? (
        <span className="ml-1 text-muted-foreground">
          · ~{percent(fraction + projected)}% {aheadLabel(windowMs)}
        </span>
      ) : stalled ? (
        <span className="ml-1 text-warning-foreground">· no movement</span>
      ) : null}
    </span>
  );
}

/** A link styled as the amber "waiting on you" note; opens the project's Decisions. */
function WaitingOnYou({ label, onOpen }: { readonly label: string; readonly onOpen: () => void }) {
  return (
    <button
      type="button"
      className="shrink-0 text-xs text-warning-foreground underline underline-offset-2 hover:text-foreground"
      onClick={onOpen}
    >
      {label}
    </button>
  );
}

function TaskStatusNote({
  task,
  onOpenDecisions,
}: {
  readonly task: PlanTask;
  readonly onOpenDecisions: () => void;
}) {
  if (task.status === "complete") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success">
        <CheckIcon className="size-3" />
        {task.issue.closedAt ? formatRelativeTimeLabel(task.issue.closedAt) : "done"}
      </span>
    );
  }
  if (task.waitingOnYou) return <WaitingOnYou label="waiting on you" onOpen={onOpenDecisions} />;
  if (task.stalled)
    return <span className="shrink-0 text-xs text-warning-foreground">no movement</span>;
  if (task.steps) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {task.steps.completed}/{task.steps.total} steps
      </span>
    );
  }
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {task.status === "active" ? "under way" : "pending"}
    </span>
  );
}

const isBug = (issue: ProjectIssue) => issue.labels.some((label) => label.toLowerCase() === "bug");

function TaskRow({
  task,
  onPage,
  onOpenDecisions,
}: {
  readonly task: PlanTask;
  readonly onPage: boolean;
  readonly onOpenDecisions: () => void;
}) {
  const title = (
    <span className={task.status === "pending" ? "text-muted-foreground" : undefined}>
      {task.issue.title}
    </span>
  );
  return (
    <li className="flex items-center gap-3 py-0.5 pl-4 text-sm">
      <span className="min-w-0 flex-[1.3] truncate">
        {/* Only the page's own tasks open in its task panel; others open on the tracker. */}
        {onPage ? (
          <TaskTitle
            task={{
              host: task.issue.host,
              repository: task.issue.repository,
              number: task.issue.number,
            }}
            url={task.issue.url}
            className="hover:underline"
          >
            {title}
          </TaskTitle>
        ) : (
          <a
            href={task.issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {title}
          </a>
        )}
        {isBug(task.issue) ? <span className="ml-2 text-xs text-muted-foreground">bug</span> : null}
      </span>
      <span className="hidden flex-1 sm:flex">
        <PlanBar
          fraction={task.fraction}
          gained={task.doneInWindow ? task.fraction : 0}
          projected={0}
          stalled={task.stalled}
          thin
        />
      </span>
      <TaskStatusNote task={task} onOpenDecisions={onOpenDecisions} />
    </li>
  );
}

function WorkstreamRow({
  stream,
  onPage,
  windowMs,
  onOpenDecisions,
}: {
  readonly stream: PlanWorkstream;
  readonly onPage: boolean;
  readonly windowMs: number;
  readonly onOpenDecisions: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const open = stream.tasks.filter((task) => task.status !== "complete");
  const shown = [
    ...(showAll ? open : open.slice(0, TASKS_SHOWN)),
    ...stream.tasks.filter((task) => task.doneInWindow),
  ];
  const hidden = open.length - Math.min(open.length, showAll ? open.length : TASKS_SHOWN);
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="min-w-0 flex-[1.3] truncate font-medium">
          {stream.epic ? stream.epic.title : "Other tasks"}
          {stream.epic ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              #{stream.epic.number}
            </span>
          ) : null}
        </span>
        <PlanBar
          fraction={stream.fraction}
          gained={stream.gained}
          projected={stream.projected}
          stalled={stream.stalled}
        />
        <ProgressLabel
          fraction={stream.fraction}
          gained={stream.gained}
          projected={stream.projected}
          stalled={stream.stalled}
          windowMs={windowMs}
        />
      </div>
      <ul>
        {shown.map((task) => (
          <TaskRow key={task.key} task={task} onPage={onPage} onOpenDecisions={onOpenDecisions} />
        ))}
      </ul>
      {hidden > 0 ? (
        <Button size="xs" variant="ghost-muted" className="ml-3" onClick={() => setShowAll(true)}>
          {hidden} more
        </Button>
      ) : null}
    </li>
  );
}

/**
 * One project in the Plan: a line with its overall progress and what waits on Brad,
 * then its workstreams and their tasks. Utility projects start folded to that line.
 * It reports its movement and recent finishes up to the widget.
 */
function PlanProject({
  project,
  onPage,
  utility,
  windowStart,
  windowMs,
  since,
  onReport,
  onOpenDecisions,
}: {
  readonly project: OrchestratorSummary;
  readonly onPage: boolean;
  readonly utility: boolean;
  readonly windowStart: number;
  readonly windowMs: number;
  readonly since: string;
  readonly onReport: (key: string, report: PlanReport) => void;
  readonly onOpenDecisions: (project: OrchestratorSummary) => void;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(!utility);
  const tasks = useTaskStatuses(project);
  const { bands } = useWorkstreamBands(project, tasks, null);
  const threadsById = useMemo(
    () =>
      new Map<string, OrchestratorThreadShell>(
        [project.root, ...project.descendants].map((thread) => [thread.id, thread]),
      ),
    [project.descendants, project.root],
  );
  const workstreams = useMemo(
    () => derivePlanWorkstreams({ bands, threadsById, windowStart }),
    [bands, threadsById, windowStart],
  );
  const totals = useMemo(() => planTotals(workstreams), [workstreams]);
  const decisions = useDecisionFeedCount(project);
  const key = `${project.root.environmentId}:${project.root.id}`;
  const issues = tasks.query.data?.issues;
  const recent = useMemo<RecentDone[]>(() => {
    const epicTitle = new Map(
      (issues ?? []).flatMap((issue) =>
        issue.epic !== undefined ? [[issue.number, issue.title] as const] : [],
      ),
    );
    return (issues ?? []).flatMap((issue) =>
      issue.closedAt !== null &&
      issue.epic === undefined &&
      issue.status !== "archived" &&
      Date.parse(issue.closedAt) > Date.parse(since)
        ? [
            {
              key: `${key}:${issue.repository}#${issue.number}`,
              title: issue.title,
              url: issue.url,
              closedAt: issue.closedAt,
              where: [issue.partOf ? epicTitle.get(issue.partOf) : null, project.root.title]
                .filter(Boolean)
                .join(" · "),
            },
          ]
        : [],
    );
  }, [issues, key, project.root.title, since]);
  // Reported by value, so an unchanged project does not re-render the widget.
  const signature = JSON.stringify({
    doneInWindow: totals.doneInWindow,
    stalled: totals.stalled,
    recent,
  } satisfies PlanReport);
  useEffect(() => {
    onReport(key, JSON.parse(signature) as PlanReport);
  }, [key, onReport, signature]);

  const nothingOpen = workstreams.length === 0;
  // A main project with nothing open stays off the plan; a utility says it is clear.
  if (nothingOpen && !utility && decisions === 0) return null;
  const openDecisions = () => onOpenDecisions(project);
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {nothingOpen ? (
          <span className="size-5" />
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={expanded ? `Fold ${project.root.title}` : `Show ${project.root.title}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        )}
        <span className="min-w-0 flex-[1.3] truncate">
          {onPage ? (
            <span className="font-semibold">{project.root.title}</span>
          ) : (
            <button
              type="button"
              className="font-semibold hover:underline"
              onClick={() =>
                void navigate({
                  to: "/orchestrators/$environmentId/$threadId",
                  params: {
                    environmentId: project.root.environmentId,
                    threadId: project.root.id,
                  },
                })
              }
            >
              {project.root.title}
            </button>
          )}
          {project.root.scope ? (
            <span className="ml-2 text-xs text-muted-foreground">{project.root.scope}</span>
          ) : null}
        </span>
        {nothingOpen ? (
          <span className="inline-flex flex-1 items-center gap-1 text-xs text-success">
            <CheckIcon className="size-3" />
            nothing open
          </span>
        ) : (
          <>
            <PlanBar
              fraction={totals.fraction}
              gained={totals.gained}
              projected={totals.projected}
              stalled={totals.stalled > 0 && totals.gained === 0}
            />
            <ProgressLabel
              fraction={totals.fraction}
              gained={totals.gained}
              projected={totals.projected}
              stalled={totals.stalled > 0 && totals.gained === 0}
              windowMs={windowMs}
            />
          </>
        )}
        {decisions > 0 ? (
          <WaitingOnYou label={`waiting on you (${decisions})`} onOpen={openDecisions} />
        ) : null}
      </div>
      {expanded && !nothingOpen ? (
        <ul className="ml-7 divide-y divide-border/60">
          {workstreams.map((stream) => (
            <WorkstreamRow
              key={stream.key}
              stream={stream}
              onPage={onPage}
              windowMs={windowMs}
              onOpenDecisions={openDecisions}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function GroupHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className="mt-3 mb-1 text-xs text-foreground/80">{children}</h3>;
}

/**
 * The Plan widget: tasks by project and workstream with progress bars, what moved in
 * the chosen window and where that pace leads, stalled work in amber, and what waits
 * on Brad opening that project's Decisions. Ends with what finished since his last visit.
 */
export function ProjectPlanWidget({
  summary,
  summaries,
  allProjects,
  utilities,
  since,
}: {
  readonly summary: OrchestratorSummary;
  /** Every project the client knows, for the All projects setting. */
  readonly summaries: ReadonlyArray<OrchestratorSummary>;
  readonly allProjects: boolean;
  readonly utilities: unknown;
  /** Brad's previous visit to this page, or null for the last day. */
  readonly since: string | null;
}) {
  const [planWindow, setPlanWindow] = useLocalStorage<PlanWindow, PlanWindow>(
    "t3code:projects:plan-window",
    "hour",
    PlanWindowSchema,
  );
  // The window slides with the clock; a minute is fine-grained enough for hours.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const windowStart = planWindowStart(planWindow, now);
  // Keep the start stable within a minute so the projects' memos hold.
  const stableStart = Math.floor(windowStart / 60_000) * 60_000;
  const windowMs = now - stableStart;
  const [firstVisitSince] = useState(() =>
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  );
  const utilityTitles = useMemo(() => parseUtilityTitles(utilities), [utilities]);
  const projects = useMemo(
    () =>
      allProjects
        ? summaries.filter((item) => item.parentProjectKey === null)
        : [summary, ...summary.subprojects],
    [allProjects, summaries, summary],
  );
  const isUtility = (project: OrchestratorSummary) =>
    utilityTitles.has(project.root.title.trim().toLowerCase());
  const main = projects.filter((project) => !isUtility(project));
  const utility = projects.filter(isUtility);

  const [reports, setReports] = useState<ReadonlyMap<string, PlanReport>>(new Map());
  const report = useCallback((key: string, value: PlanReport) => {
    setReports((current) => new Map(current).set(key, value));
  }, []);
  const [decisionsFor, setDecisionsFor] = useState<OrchestratorSummary | null>(null);

  const keys = new Set(
    projects.map((project) => `${project.root.environmentId}:${project.root.id}`),
  );
  const live = [...reports].filter(([key]) => keys.has(key)).map(([, value]) => value);
  const done = live.reduce((total, item) => total + item.doneInWindow, 0);
  const stalled = live.reduce((total, item) => total + item.stalled, 0);
  const recent = live
    .flatMap((item) => item.recent)
    .toSorted((a, b) => b.closedAt.localeCompare(a.closedAt))
    .slice(0, RECENT_SHOWN);

  const renderProject = (project: OrchestratorSummary, asUtility: boolean) => (
    <PlanProject
      key={`${project.root.environmentId}:${project.root.id}`}
      project={project}
      onPage={project === summary}
      utility={asUtility}
      windowStart={stableStart}
      windowMs={windowMs}
      since={since ?? firstVisitSince}
      onReport={report}
      onOpenDecisions={setDecisionsFor}
    />
  );

  return (
    <ProjectSection
      title="Plan"
      action={
        <span className="flex items-center gap-1">
          {WINDOWS.map((item) => (
            <Button
              key={item}
              size="xs"
              variant={item === planWindow ? "secondary" : "ghost-muted"}
              aria-pressed={item === planWindow}
              onClick={() => setPlanWindow(item)}
            >
              {PLAN_WINDOW_LABEL[item]}
            </Button>
          ))}
        </span>
      }
    >
      <p className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {done === 0 ? "Nothing finished" : `${done} ${done === 1 ? "task" : "tasks"} finished`}
          {stalled > 0 ? (
            <span className="text-warning-foreground"> · {stalled} stalled</span>
          ) : null}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-4 rounded-full bg-info/55" /> done
          <span className="ml-2 inline-block h-1.5 w-4 rounded-full bg-info" /> this window
          <span
            className="ml-2 inline-block h-1.5 w-4 rounded-full text-info/45"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, currentColor 0 3px, transparent 3px 6px)",
            }}
          />{" "}
          at this pace
        </span>
      </p>
      <ul className="divide-y divide-border">
        {main.map((project) => renderProject(project, false))}
      </ul>
      {utility.length > 0 ? (
        <>
          <GroupHeading>Utilities</GroupHeading>
          <ul className="divide-y divide-border">
            {utility.map((project) => renderProject(project, true))}
          </ul>
        </>
      ) : null}
      {recent.length > 0 ? (
        <>
          <GroupHeading>
            Done since you last looked{" "}
            <span className="tabular-nums text-muted-foreground">{recent.length}</span>
          </GroupHeading>
          <ul>
            {recent.map((item) => (
              <li key={item.key} className="flex items-baseline gap-2 py-0.5 text-sm">
                <CheckIcon className="size-3.5 shrink-0 self-center text-success" />
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 truncate hover:underline"
                >
                  {item.title}
                </a>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {item.where}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(item.closedAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Dialog open={decisionsFor !== null} onOpenChange={(open) => !open && setDecisionsFor(null)}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Waiting on you · {decisionsFor?.root.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {decisionsFor ? <ProjectDecisionFeed summary={decisionsFor} /> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </ProjectSection>
  );
}
