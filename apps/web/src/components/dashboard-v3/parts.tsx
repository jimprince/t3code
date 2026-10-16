import { isNewlyFiled, newMarkTitle } from "@t3tools/client-runtime/dashboard/order";
import { blockerHeadline, taskBlockers } from "@t3tools/client-runtime/dashboard/blockers";
import type { DashboardRelease, DashboardTask, ProjectRequestPlacer } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { projectIssuesQuery } from "../../state/projectIssues";
import { useEnvironmentQuery } from "../../state/query";
import { BadgeShell, BlockerList, blockerOfRow, WaitingList } from "../blockers/BlockerBadge";
import { useBlockerPermissions } from "../blockers/useBlockerActions";
import { useOrchestratorThreadShells } from "../orchestrators/useOrchestratorThreads";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useDashboardUi } from "./context";
import { useOpenDecisionSource } from "./decisions";
import { isThreadPlanTaskId } from "./resumeFromPlan.logic";
import { ThreadPlanLine } from "./ThreadPlanLine";
import {
  barSegments,
  formatClock,
  formatEta,
  hasStepList,
  knownConfirmation,
  planNotes,
  rollup,
  type Rollup,
  type ScopedProject,
} from "./dashboard.logic";

const HOUR_MS = 3_600_000;
const NO_KEYS: ReadonlyArray<string> = [];

/** The forecast hatch is a static pattern in the info colour, never animated. */
const HATCH =
  "repeating-linear-gradient(135deg, color-mix(in srgb, var(--info) 55%, transparent) 0 2px, transparent 2px 5px)";

export type BarTone = "default" | "warning" | "done";

/**
 * Done before the window (solid), steps gained in it (light), forecast to the end of the next
 * window (hatched). Amber replaces the solid colour when stalled or waiting on Brad, green when
 * done. A dashed empty outline means the progress is unknown; no `steps` draws nothing.
 */
export function ProgressBar({
  steps,
  gained,
  projectedDone,
  tone = "default",
  unknown = false,
  small = false,
  unit = "steps",
}: {
  readonly steps: { readonly done: number; readonly total: number } | null;
  readonly gained: number | null;
  readonly projectedDone: number | null;
  readonly tone?: BarTone;
  readonly unknown?: boolean;
  readonly small?: boolean;
  /** What the bar counts: a task's steps, or a workstream's child tasks. */
  readonly unit?: "steps" | "tasks";
}) {
  const height = small ? "h-[5px]" : "h-[7px]";
  if (unknown)
    return (
      <span
        role="img"
        aria-label="Progress unknown"
        className={cn("block min-w-[60px] rounded-full border border-dashed border-border", height)}
      />
    );
  if (!steps) return <span className={cn("block min-w-[60px] invisible", height)} aria-hidden />;
  const bar = barSegments({
    done: steps.done,
    total: steps.total,
    gained: gained ?? 0,
    projectedDone,
  });
  const solid = tone === "done" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-info";
  return (
    <span
      role="img"
      aria-label={`${steps.done} of ${steps.total} ${unit}`}
      className={cn("flex min-w-[60px] overflow-hidden rounded-full bg-muted", height)}
    >
      <i className={cn("block h-full", solid)} style={{ width: `${bar.done}%` }} />
      <i className="block h-full bg-info/45" style={{ width: `${bar.gained}%` }} />
      <i className="block h-full" style={{ width: `${bar.projected}%`, backgroundImage: HATCH }} />
    </span>
  );
}

export type SectionName = "ask" | "plan" | "releases" | "decisions" | "outcomes" | "utilities";

/**
 * The attributes the cold-load trace reads to tell when a section shows its rows or its truthful
 * empty state. A section is ready once a whole snapshot is on screen, with that snapshot's revision.
 */
export function sectionMarker(
  name: SectionName,
  snapshot: { readonly ready: boolean; readonly revision: string },
) {
  return {
    "data-testid": `dashboard-section-${name}`,
    "data-ready": snapshot.ready ? "true" : "false",
    "data-revision": snapshot.revision,
  } as const;
}

export function useSectionMarker(name: SectionName) {
  const { data, revision } = useDashboardUi();
  return sectionMarker(name, { ready: data.asOf !== null, revision });
}

/**
 * A layout-neutral block that carries a section's marker. `hidden` keeps an empty section present
 * for the trace without taking a flex or grid gap.
 */
export function SectionMarker({
  name,
  hidden = false,
  className,
  children,
}: {
  readonly name: SectionName;
  readonly hidden?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const marker = useSectionMarker(name);
  return (
    <div {...marker} hidden={hidden} className={className}>
      {children}
    </div>
  );
}

/** Unknown stays unknown: italic, never 0 and never an old value presented as current. */
export function UnknownValue({
  since,
  children,
}: {
  readonly since?: string | null | undefined;
  readonly children?: ReactNode;
}) {
  const { now } = useDashboardUi();
  return (
    <span className="text-muted-foreground italic">
      {children ?? "unknown"}
      {since ? ` since ${formatClock(since, now)}` : ""}
    </span>
  );
}

/**
 * The amber "Waiting on Brad" on a row that waits on decisions: opens one popover with exactly the
 * decisions blocking it, each answerable in place, and "Open" for the full card behind it.
 */
export function WaitingOnYou({
  keys,
  label = "Waiting on Brad",
}: {
  readonly keys: ReadonlyArray<string>;
  readonly label?: string;
}) {
  const { decisions } = useDashboardUi();
  const openSource = useOpenDecisionSource();
  const [open, setOpen] = useState(false);
  const entries = useMemo(
    () =>
      keys.flatMap((key) => {
        const row = decisions.find((entry) => entry.key === key);
        return row ? [{ row, blocker: blockerOfRow(row) }] : [];
      }),
    [keys, decisions],
  );
  return (
    <BadgeShell
      tone="amber"
      label={`${label}${entries.length > 1 ? ` (${entries.length})` : ""}`}
      ariaLabel={`${label}: the decisions blocking this and their answers`}
      settledLabel="Answered"
      active={entries.length > 0}
      open={open}
      onOpenChange={setOpen}
    >
      <WaitingList
        entries={entries}
        headline={blockerHeadline(entries.map((entry) => entry.blocker))}
        asOf={null}
        stored={false}
        openItem={openSource}
      />
    </BadgeShell>
  );
}

/** "6/9 +3 · ~7/9 by 8:42" or "12/18 +3 · owner ETA 11:00 am": a figure and the basis of its forecast. */
export function ProgressFigure({
  roll,
  total,
  keys = NO_KEYS,
  extra,
  unit,
}: {
  readonly roll: Rollup;
  readonly total?: number | undefined;
  readonly keys?: ReadonlyArray<string>;
  readonly extra?: ReactNode;
  /** Names the unit after the figure ("10/20 tasks") when it is not the task steps. */
  readonly unit?: string;
}) {
  const { data, now } = useDashboardUi();
  const steps = roll.steps;
  const forecastBy = () =>
    formatClock(
      new Date(Date.parse(data.asOf ?? new Date(now).toISOString()) + HOUR_MS).toISOString(),
      now,
    );
  return (
    <span className="tabular-nums whitespace-nowrap">
      {steps ? (
        <>
          {steps.done}/{total ?? steps.total}
          {unit ? ` ${unit}` : ""}
          {roll.gained ? <span className="text-info"> +{roll.gained}</span> : null}
        </>
      ) : null}
      {roll.ownerEta ? (
        <span className="text-muted-foreground">
          {" "}
          · owner ETA {formatEta(roll.ownerEta, roll.ownerEtaDateOnly, now)}
        </span>
      ) : roll.projectedDone !== null && steps && roll.paceBasis ? (
        <span className="text-muted-foreground">
          {" "}
          · ~{roll.projectedDone}/{steps.total} by {forecastBy()}
        </span>
      ) : null}
      {roll.replanned ? <span className="text-muted-foreground"> · replanned</span> : null}
      {roll.unplanned > 0 ? (
        <span className="text-muted-foreground/70">
          {steps ? " · " : ""}
          {roll.unplanned} {steps ? "more " : "open "}
          {roll.unplanned === 1 ? "task" : "tasks"}
        </span>
      ) : null}
      {extra}
      {keys.length > 0 ? (
        <>
          {" "}
          <WaitingOnYou keys={keys} />
        </>
      ) : null}
    </span>
  );
}

const STATUS_WORDS: Record<DashboardTask["status"], string> = {
  pending: "queued",
  working: "in progress",
  blocked: "blocked",
  review: "ready for review",
  done: "done",
};

/** The popup of a task's Blocked badge: what actually blocks it, derived only while it is open. */
function TaskBlockers({
  scoped,
  task,
}: {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
}) {
  const ui = useDashboardUi();
  const shells = useOrchestratorThreadShells();
  const { environmentId } = scoped;
  const rootId = scoped.project.rootThreadId;
  const issues = useEnvironmentQuery(
    rootId ? projectIssuesQuery({ environmentId, input: { rootThreadId: rootId } }) : null,
  ).data?.issues;
  const permissions = useBlockerPermissions(environmentId);
  const [now] = useState(() => new Date().toISOString());
  const blockers = useMemo(
    () => taskBlockers(task, shells, issues ?? [], { ...permissions, now }),
    [task, shells, issues, permissions, now],
  );
  return (
    <BlockerList
      blockers={blockers}
      rowEnvironmentId={environmentId}
      scopeRootId={rootId}
      emptyText={`Blocked: ${task.title}`}
    >
      <div>
        <InlineButton tone="muted" onClick={() => ui.openTask(scoped, task)}>
          Open task
        </InlineButton>
      </div>
    </BlockerList>
  );
}

/**
 * The red "Blocked" on a task the snapshot marks blocked with no decision behind it. The popover
 * names the real cause: a held queue (with Resume queue), a failed or stopped thread, an open issue
 * it depends on, or a question in its thread, and otherwise says only that the task is blocked.
 */
function TaskBlocked({
  scoped,
  task,
}: {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
}) {
  const [open, setOpen] = useState(false);
  return (
    <BadgeShell
      tone="red"
      label="Blocked"
      ariaLabel="Blocked: what holds this task"
      settledLabel="Cleared"
      active
      open={open}
      onOpenChange={setOpen}
    >
      <TaskBlockers scoped={scoped} task={task} />
    </BadgeShell>
  );
}

/** Whether the task's step list comes from a source that is stale or failed. */
function useTaskSourceStale(task: DashboardTask): boolean {
  const { sourceHealth } = useDashboardUi();
  const health = task.progress ? sourceHealth(task.progress.sourceId) : null;
  return health === "stale" || health === "failed";
}

/**
 * "new" beside an item filed in the last four hours, wherever it shows; hovering says who placed
 * it, or that nobody has. It expires by the item's created time and nothing is written to clear it.
 */
export function NewMark({
  item,
}: {
  readonly item: {
    readonly createdAt?: string | undefined;
    readonly rank?: number | null | undefined;
    readonly placedBy?: ProjectRequestPlacer | null | undefined;
  };
}) {
  const { now } = useDashboardUi();
  if (!isNewlyFiled(item.createdAt, now)) return null;
  const title = newMarkTitle(item);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span aria-label={title} data-testid="new-mark" className="ml-1.5 text-info">
            new
          </span>
        }
      />
      <TooltipPopup>{title}</TooltipPopup>
    </Tooltip>
  );
}

/** One task: status mark, title, its own bar when it has a real step list, and its figure. */
export function TaskRow({
  scoped,
  task,
  flush = false,
}: {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
  /** Sits beside order controls that already indent the row. */
  readonly flush?: boolean;
}) {
  const ui = useDashboardUi();
  const stale = useTaskSourceStale(task) && hasStepList(task);
  const keys = ui.decisionKeysFor(scoped, task);
  const roll = rollup([task]);
  const idle = roll.idle > 0;
  const done = task.status === "done";
  const tone: BarTone = done ? "done" : keys.length > 0 || idle ? "warning" : "default";
  const ref = /#(\d+)$/.exec(task.id)?.[1];
  const mark = done ? (
    <CheckIcon className="size-3.5 text-success" aria-label="done" />
  ) : keys.length > 0 || idle ? (
    <span className="text-warning-foreground" aria-label="needs attention">
      ▲
    </span>
  ) : task.status === "pending" || task.status === "blocked" ? (
    <span className="text-muted-foreground/60" aria-label={STATUS_WORDS[task.status]}>
      ○
    </span>
  ) : (
    <span className="text-info" aria-label="in progress">
      ●
    </span>
  );
  return (
    <div
      className={cn(
        "grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-0.5 text-xs @xl/dash:grid-cols-[14px_minmax(120px,1fr)_96px_minmax(110px,auto)]",
        !flush && "pl-3.5",
      )}
    >
      <span className="text-center">{mark}</span>
      <button
        type="button"
        className={cn(
          "line-clamp-3 min-w-0 break-words text-left hover:underline",
          task.status === "pending" && "text-muted-foreground",
        )}
        onClick={() => ui.openTask(scoped, task)}
      >
        {task.title}
        {ref ? <span className="ml-1 text-muted-foreground/70">#{ref}</span> : null}
        {task.bug ? <span className="ml-1.5 text-destructive-foreground">bug</span> : null}
        <NewMark item={task} />
      </button>
      <span className="order-last col-span-3 pl-6 @xl/dash:order-none @xl/dash:col-span-1 @xl/dash:pl-0">
        {hasStepList(task) && !stale ? (
          <ProgressBar
            small
            steps={{ done: task.progress.done, total: task.progress.total }}
            gained={roll.gained}
            projectedDone={roll.projectedDone}
            tone={tone}
          />
        ) : stale && hasStepList(task) ? (
          <ProgressBar small steps={null} gained={null} projectedDone={null} unknown />
        ) : null}
      </span>
      <span className="text-right @xl/dash:col-auto">
        <TaskFigure scoped={scoped} task={task} roll={roll} keys={keys} stale={stale} idle={idle} />
      </span>
      {planNotes(task.membershipWarnings).map((line) => (
        <span
          key={line}
          className="order-last col-span-3 min-w-0 pl-6 text-muted-foreground @xl/dash:order-none @xl/dash:col-span-3 @xl/dash:col-start-2 @xl/dash:pl-0"
        >
          {line}
        </span>
      ))}
      {task.threadId && !done ? (
        <ThreadPlanLine
          environmentId={scoped.environmentId}
          task={task}
          planRow={isThreadPlanTaskId(task.id)}
          className="order-last col-span-3 mt-1 pl-6 @xl/dash:order-none @xl/dash:col-span-3 @xl/dash:col-start-2 @xl/dash:mt-0 @xl/dash:pl-0"
        />
      ) : null}
    </div>
  );
}

interface TaskFigureProps {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
  readonly roll: Rollup;
  readonly keys: ReadonlyArray<string>;
  readonly stale: boolean;
  readonly idle: boolean;
}

/** A blocked task with no decision behind it always carries the Blocked badge, whatever else it shows. */
function TaskFigure(props: TaskFigureProps) {
  const { scoped, task, keys } = props;
  return (
    <>
      <TaskFigureBody {...props} />
      {task.status === "blocked" && keys.length === 0 ? (
        <>
          {" "}
          <TaskBlocked scoped={scoped} task={task} />
        </>
      ) : null}
    </>
  );
}

function TaskFigureBody({ task, roll, keys, stale, idle }: TaskFigureProps) {
  const { now } = useDashboardUi();
  if (task.status === "done") {
    const at = task.closedAt ?? knownConfirmation(task.progress);
    return (
      <span className="text-success whitespace-nowrap">
        done{at ? ` ${formatClock(at, now)}` : ""}
      </span>
    );
  }
  if (stale && task.progress)
    return (
      <span className="inline-block text-right @max-[90rem]/dash:max-w-[14rem]">
        <UnknownValue since={knownConfirmation(task.progress)}>progress unknown</UnknownValue>
      </span>
    );
  // A tracker task with no checklist has nothing to measure: say so rather than draw 0 of 1. Its
  // latest note's next action (the contract's home for "deploy 09:30Z") shows in place of the words.
  if (task.progress && task.hasChecklist === false)
    return (
      <span className="inline-block text-right text-muted-foreground/80 max-w-[16rem] @3xl/dash:max-w-[22rem]">
        {task.nextStep ? (
          <Tooltip>
            <TooltipTrigger render={<span className="line-clamp-2 break-words" />}>
              next: {task.nextStep}
            </TooltipTrigger>
            <TooltipPopup>{task.nextStep}</TooltipPopup>
          </Tooltip>
        ) : (
          <span className="whitespace-nowrap">no checklist yet</span>
        )}
        {roll.ownerEta ? (
          <span className="whitespace-nowrap">
            {" "}
            · owner ETA {formatEta(roll.ownerEta, roll.ownerEtaDateOnly, now)}
          </span>
        ) : null}
        {keys.length > 0 ? (
          <>
            {" "}
            <WaitingOnYou keys={keys} />
          </>
        ) : null}
      </span>
    );
  if (!task.progress)
    return (
      <span className="whitespace-nowrap text-muted-foreground/80">
        {keys.length > 0 ? (
          <WaitingOnYou keys={keys} />
        ) : task.nextStep ? (
          task.nextStep
        ) : task.status === "blocked" ? null : (
          STATUS_WORDS[task.status]
        )}
      </span>
    );
  return (
    <ProgressFigure
      roll={roll}
      keys={keys}
      extra={idle ? <span className="text-warning-foreground"> · no steps this hour</span> : null}
    />
  );
}

/** A finished item with its level, as the Done list shows it. */
export function OutcomeRow({
  title,
  level,
  at,
}: {
  readonly title: string;
  readonly level?: string;
  readonly at?: string | null;
}) {
  const { now } = useDashboardUi();
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-xs">
      <CheckIcon className="size-3.5 shrink-0 translate-y-0.5 text-success" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {title}
        {level ? <span className="text-muted-foreground/70"> {level}</span> : null}
      </span>
      {at ? (
        <span className="text-muted-foreground/70 tabular-nums">{formatClock(at, now)}</span>
      ) : null}
    </div>
  );
}

/** A section heading with its counts inline, never a subtitle line. */
export function SectionHeading({
  title,
  children,
  right,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly right?: ReactNode;
}) {
  return (
    <h2 className="mt-4 mb-1.5 flex flex-wrap items-baseline gap-x-2.5 text-sm font-semibold">
      {title}
      {children ? (
        <span className="text-xs font-normal text-muted-foreground">{children}</span>
      ) : null}
      {right ? (
        <span className="ml-auto text-xs font-normal text-muted-foreground">{right}</span>
      ) : null}
    </h2>
  );
}

/** The bar legend: what the three segments mean for the window in use. */
export function BarLegend({
  gainedLabel,
  byLabel,
}: {
  readonly gainedLabel: string;
  readonly byLabel: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 text-xs font-normal text-muted-foreground">
      <span>
        <i className="mr-1 inline-block h-1.5 w-3.5 rounded-sm bg-info align-middle" />
        done
      </span>
      <span>
        <i className="mr-1 inline-block h-1.5 w-3.5 rounded-sm bg-info/45 align-middle" />
        {gainedLabel}
      </span>
      <span>
        <i
          className="mr-1 inline-block h-1.5 w-3.5 rounded-sm align-middle"
          style={{ backgroundImage: HATCH }}
        />
        {byLabel}
      </span>
    </span>
  );
}

/** Tasks keyed for a release: its own step list, or the task it tracks. */
export function releaseTask(
  projects: ReadonlyArray<ScopedProject>,
  release: DashboardRelease,
): { readonly scoped: ScopedProject; readonly task: DashboardTask } | null {
  if (!release.taskId) return null;
  for (const scoped of projects) {
    const task = scoped.project.tasks.find((candidate) => candidate.id === release.taskId);
    if (task) return { scoped, task };
  }
  return null;
}
