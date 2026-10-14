import type { DashboardRelease, DashboardTask } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useDashboardUi } from "./context";
import {
  barSegments,
  formatClock,
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
}: {
  readonly steps: { readonly done: number; readonly total: number } | null;
  readonly gained: number | null;
  readonly projectedDone: number | null;
  readonly tone?: BarTone;
  readonly unknown?: boolean;
  readonly small?: boolean;
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
      aria-label={`${steps.done} of ${steps.total} steps`}
      className={cn("flex min-w-[60px] overflow-hidden rounded-full bg-muted", height)}
    >
      <i className={cn("block h-full", solid)} style={{ width: `${bar.done}%` }} />
      <i className="block h-full bg-info/45" style={{ width: `${bar.gained}%` }} />
      <i className="block h-full" style={{ width: `${bar.projected}%`, backgroundImage: HATCH }} />
    </span>
  );
}

export type SectionName =
  | "ask"
  | "freshness"
  | "plan"
  | "releases"
  | "decisions"
  | "outcomes"
  | "utilities";

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

/** The amber link on a blocked row that opens exactly the decision card blocking it. */
export function WaitingOnYou({
  keys,
  label = "waiting on you",
}: {
  readonly keys: ReadonlyArray<string>;
  readonly label?: string;
}) {
  const { openDecisions } = useDashboardUi();
  if (keys.length === 0) return null;
  return (
    <button
      type="button"
      className="cursor-pointer whitespace-nowrap text-warning-foreground underline decoration-warning/45 underline-offset-2 hover:decoration-warning"
      onClick={() => openDecisions(keys)}
    >
      {label}
      {keys.length > 1 ? ` (${keys.length})` : ""}
    </button>
  );
}

/** "6/9 +3 · ~7/9 by 8:42" or "12/18 +3 · owner ETA 11:00 am": a figure and the basis of its forecast. */
export function ProgressFigure({
  roll,
  total,
  keys = NO_KEYS,
  extra,
}: {
  readonly roll: Rollup;
  readonly total?: number | undefined;
  readonly keys?: ReadonlyArray<string>;
  readonly extra?: ReactNode;
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
          {roll.gained ? <span className="text-info"> +{roll.gained}</span> : null}
        </>
      ) : null}
      {roll.ownerEta ? (
        <span className="text-muted-foreground">
          {" "}
          · owner ETA {formatClock(roll.ownerEta, now)}
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

// "blocked" without an open decision means another issue holds the task, not Brad.
const STATUS_WORDS: Record<DashboardTask["status"], string> = {
  pending: "queued",
  working: "in progress",
  blocked: "blocked",
  review: "ready for review",
  done: "done",
};

/** Whether the task's step list comes from a source that is stale or failed. */
function useTaskSourceStale(task: DashboardTask): boolean {
  const { sourceHealth } = useDashboardUi();
  const health = task.progress ? sourceHealth(task.progress.sourceId) : null;
  return health === "stale" || health === "failed";
}

/** One task: status mark, title, its own bar when it has a real step list, and its figure. */
export function TaskRow({
  scoped,
  task,
}: {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
}) {
  const ui = useDashboardUi();
  const stale = useTaskSourceStale(task);
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
    <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-0.5 pl-3.5 text-xs @xl/dash:grid-cols-[14px_minmax(120px,1fr)_96px_minmax(110px,auto)]">
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
      </button>
      <span className="order-last col-span-3 pl-6 @xl/dash:order-none @xl/dash:col-span-1 @xl/dash:pl-0">
        {task.progress && !stale ? (
          <ProgressBar
            small
            steps={{ done: task.progress.done, total: task.progress.total }}
            gained={roll.gained}
            projectedDone={roll.projectedDone}
            tone={tone}
          />
        ) : stale ? (
          <ProgressBar small steps={null} gained={null} projectedDone={null} unknown />
        ) : null}
      </span>
      <span className="text-right @xl/dash:col-auto">
        <TaskFigure scoped={scoped} task={task} roll={roll} keys={keys} stale={stale} idle={idle} />
      </span>
    </div>
  );
}

function TaskFigure({
  task,
  roll,
  keys,
  stale,
  idle,
}: {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
  readonly roll: Rollup;
  readonly keys: ReadonlyArray<string>;
  readonly stale: boolean;
  readonly idle: boolean;
}) {
  const { now } = useDashboardUi();
  if (task.status === "done")
    return (
      <span className="text-success whitespace-nowrap">
        done{task.progress ? ` ${formatClock(task.progress.confirmedAt, now)}` : ""}
      </span>
    );
  if (stale && task.progress)
    return <UnknownValue since={task.progress.confirmedAt}>progress unknown</UnknownValue>;
  if (!task.progress)
    return (
      <span className="whitespace-nowrap text-muted-foreground/80">
        {keys.length > 0 ? (
          <WaitingOnYou keys={keys} />
        ) : (
          (task.nextStep ?? STATUS_WORDS[task.status])
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
