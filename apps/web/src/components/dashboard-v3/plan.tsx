import type { DashboardTask } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useDashboardUi } from "./context";
import {
  formatClock,
  projectTasks,
  rollup,
  subprojectsOf,
  workstreamTasks,
  type ScopedProject,
} from "./dashboard.logic";
import {
  ProgressBar,
  ProgressFigure,
  releaseTask,
  TaskRow,
  UnknownValue,
  useSectionMarker,
  WaitingOnYou,
} from "./parts";

/** Decision keys blocking any of these tasks, without repeats. */
function blockingKeys(
  decisionKeysFor: (scoped: ScopedProject, task: DashboardTask) => ReadonlyArray<string>,
  scoped: ScopedProject,
  tasks: ReadonlyArray<DashboardTask>,
) {
  return [...new Set(tasks.flatMap((task) => decisionKeysFor(scoped, task)))];
}

/**
 * Releases (R10): where the release stands, how far the nightlies lag, and installed against
 * latest. A line shows only the facts the snapshot has; the rest is left out or marked unknown.
 */
export function ReleaseLines() {
  const ui = useDashboardUi();
  const { data, now } = ui;
  if (data.releases.length === 0) return null;
  return (
    <div className="flex flex-col divide-y divide-border">
      {data.releases.map(({ environmentId, release }) => {
        const found = releaseTask(data.projects, release);
        const roll = found ? rollup([found.task]) : null;
        const keys = found ? ui.decisionKeysFor(found.scoped, found.task) : [];
        const eta = release.eta ?? roll?.ownerEta ?? null;
        const lag = release.nightlyLagDays;
        const mismatch =
          release.installedVersion !== null &&
          release.latestVersion !== null &&
          release.installedVersion !== release.latestVersion;
        return (
          <div key={`${environmentId}:${release.id}`} className="flex flex-col py-1">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[130px_minmax(0,1fr)_170px_auto]">
              <span className="truncate font-semibold">{release.title}</span>
              <span className="order-3 col-span-2 sm:order-none sm:col-span-1">
                {found?.task.progress ? (
                  <ProgressBar
                    steps={{ done: found.task.progress.done, total: found.task.progress.total }}
                    gained={roll?.gained ?? null}
                    projectedDone={roll?.projectedDone ?? null}
                    tone={keys.length > 0 ? "warning" : "default"}
                  />
                ) : null}
              </span>
              <span className="text-right tabular-nums sm:text-left">
                {release.phase ? <>{release.phase} · </> : null}
                {found?.task.progress ? (
                  <>
                    {found.task.progress.done}/{found.task.progress.total}
                    {roll?.gained ? <span className="text-info"> +{roll.gained}</span> : null}
                  </>
                ) : (
                  <UnknownValue>no step list</UnknownValue>
                )}
              </span>
              <span className="text-right tabular-nums">
                {eta ? <>ETA {formatClock(eta, now)} </> : null}
                <WaitingOnYou keys={keys} />
              </span>
            </div>
            {lag !== undefined && lag !== null ? (
              <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 py-0.5 text-xs">
                <span className="font-semibold">Nightlies</span>
                <span>
                  <span className={lag > 0 ? "text-destructive-foreground" : "text-success"}>
                    {lag > 0 ? `${lag} ${lag === 1 ? "day" : "days"} behind` : "caught up"}
                  </span>
                  {release.nightlySync ? (
                    <span>, last synced {formatClock(release.nightlySync, now)}</span>
                  ) : null}
                  <span className="text-muted-foreground"> · catch-up </span>
                  <UnknownValue />
                </span>
              </div>
            ) : null}
            {release.installedVersion !== null || release.latestVersion !== null ? (
              <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 py-0.5 text-xs">
                <span className="font-semibold">Installed</span>
                <span>
                  <span className={cn(mismatch && "text-warning-foreground")}>
                    {release.installedVersion ?? <UnknownValue />}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    · latest {release.latestVersion ?? <UnknownValue />}
                  </span>
                  {!mismatch && release.installedVersion !== null ? (
                    <span className="text-success"> ✓</span>
                  ) : null}
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A workstream's row and, when open, its tasks. Collapse is remembered on this device. */
export function WorkstreamRow({
  scoped,
  workstreamId,
  title,
  tasks,
  openByDefault,
}: {
  readonly scoped: ScopedProject;
  readonly workstreamId: string;
  readonly title: string;
  readonly tasks: ReadonlyArray<DashboardTask>;
  readonly openByDefault: boolean;
}) {
  const ui = useDashboardUi();
  const key = `ws:${scoped.key}|${workstreamId}`;
  const collapsed = ui.isCollapsed(key, !openByDefault);
  const roll = rollup(tasks);
  const keys = blockingKeys(ui.decisionKeysFor, scoped, tasks);
  const stale = tasks.some((task) => {
    const health = task.progress ? ui.sourceHealth(task.progress.sourceId) : null;
    return health === "stale" || health === "failed";
  });
  const since = stale
    ? tasks
        .map((task) => task.progress?.confirmedAt)
        .filter((v): v is string => !!v)
        .toSorted()[0]
    : undefined;
  const allDone = tasks.length > 0 && tasks.every((task) => task.status === "done");
  const tone = allDone ? "done" : keys.length > 0 || roll.idle > 0 ? "warning" : "default";
  return (
    <div>
      <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-0.75 sm:grid-cols-[14px_minmax(150px,1.25fr)_minmax(110px,1.6fr)_minmax(170px,auto)]">
        <button
          type="button"
          aria-label={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
          className="text-muted-foreground/70"
          onClick={() => ui.toggleCollapsed(key)}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3" />
          ) : (
            <ChevronDownIcon className="size-3" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 truncate text-left font-medium hover:underline"
          onClick={() => ui.toggleCollapsed(key)}
        >
          {title}
        </button>
        <span className="order-last col-span-3 sm:order-none sm:col-span-1">
          <ProgressBar
            steps={roll.steps}
            gained={roll.gained}
            projectedDone={roll.projectedDone}
            tone={tone}
            unknown={stale}
          />
        </span>
        <span className="text-right">
          {stale ? (
            <>
              <UnknownValue since={since}>progress unknown</UnknownValue>{" "}
              <WaitingOnYou keys={keys} />
            </>
          ) : (
            <ProgressFigure roll={roll} keys={keys} />
          )}
        </span>
      </div>
      {collapsed
        ? null
        : tasks.map((task) => <TaskRow key={task.id} scoped={scoped} task={task} />)}
    </div>
  );
}

/** One line for a subproject or utility: its name, a bar over its own tasks, and the figure. */
export function SubprojectRow({
  scoped,
  all,
  dim = false,
}: {
  readonly scoped: ScopedProject;
  readonly all: ReadonlyArray<ScopedProject>;
  readonly dim?: boolean;
}) {
  const ui = useDashboardUi();
  const tasks = projectTasks(all, scoped);
  const roll = rollup(tasks);
  const keys = blockingKeys(ui.decisionKeysFor, scoped, scoped.project.tasks);
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-0.75 sm:grid-cols-[14px_minmax(150px,1.25fr)_minmax(110px,1.6fr)_minmax(170px,auto)]">
      <span />
      <button
        type="button"
        className={cn("min-w-0 truncate text-left hover:underline", dim && "text-muted-foreground")}
        onClick={() => ui.openProject(scoped)}
      >
        {scoped.project.title}
      </button>
      <span className="order-last col-span-3 sm:order-none sm:col-span-1">
        <ProgressBar
          small
          steps={roll.steps}
          gained={roll.gained}
          projectedDone={roll.projectedDone}
          tone={keys.length > 0 || roll.idle > 0 ? "warning" : "default"}
        />
      </span>
      <span className="text-right">
        {tasks.length === 0 ? (
          <span className="text-muted-foreground/80">no open work</span>
        ) : (
          <ProgressFigure roll={roll} keys={keys} />
        )}
      </span>
    </div>
  );
}

/**
 * A project's block of the Plan: its name, its finite workstreams with their tasks, then its
 * subprojects as single lines. `showName` is off on the project's own page.
 */
export function ProjectGroup({
  scoped,
  all,
  showName = true,
}: {
  readonly scoped: ScopedProject;
  readonly all: ReadonlyArray<ScopedProject>;
  readonly showName?: boolean;
}) {
  const ui = useDashboardUi();
  const { project } = scoped;
  const subs = subprojectsOf(all, scoped).filter((sub) => sub.project.parentId === project.id);
  const workstreams = project.workstreams
    .map((workstream) => ({ workstream, tasks: workstreamTasks(project, workstream) }))
    .filter((entry) => entry.tasks.length > 0);
  const name = (
    <button
      type="button"
      className="font-semibold hover:underline"
      onClick={() => ui.openProject(scoped)}
    >
      {project.title}
    </button>
  );
  return (
    <div className="border-t border-border py-1.5 first:border-t-0">
      {showName ? <div className="flex items-baseline gap-2 pb-1">{name}</div> : null}
      {workstreams.length === 0 && subs.length === 0 ? (
        <div className="py-0.5 pl-6 text-muted-foreground/80">
          {project.omittedTaskCount > 0
            ? `${project.omittedTaskCount} tasks not in this snapshot`
            : "No open work"}
        </div>
      ) : null}
      {workstreams.map(({ workstream, tasks }) => (
        <WorkstreamRow
          key={workstream.id}
          scoped={scoped}
          workstreamId={workstream.id}
          title={workstream.title}
          tasks={tasks}
          openByDefault={
            workstreams.length === 1 ||
            tasks.some(
              (task) =>
                task.attentionIds.length > 0 ||
                (task.movement.state === "measured" && (task.movement.doneDelta ?? 0) > 0),
            )
          }
        />
      ))}
      {project.omittedTaskCount > 0 && workstreams.length > 0 ? (
        <div className="py-0.5 pl-6 text-muted-foreground/80">
          +{project.omittedTaskCount} more tasks not in this snapshot
        </div>
      ) : null}
      {subs.map((sub) => (
        <SubprojectRow key={sub.key} scoped={sub} all={all} dim />
      ))}
    </div>
  );
}

/** Utilities, apart from product work and collapsed on phone width until opened. */
export function UtilityGroup({
  utilities,
  all,
}: {
  readonly utilities: ReadonlyArray<ScopedProject>;
  readonly all: ReadonlyArray<ScopedProject>;
}) {
  const ui = useDashboardUi();
  const marker = useSectionMarker("utilities");
  if (utilities.length === 0) return <div {...marker} hidden />;
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
  const key = "utilities";
  const collapsed = ui.isCollapsed(key, phone);
  return (
    <div {...marker} className="border-t border-border py-1.5">
      <button
        type="button"
        aria-expanded={!collapsed}
        className="flex items-center gap-1 pb-1 font-semibold"
        onClick={() => ui.toggleCollapsed(key)}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3" />
        ) : (
          <ChevronDownIcon className="size-3" />
        )}
        Utilities
      </button>
      {collapsed
        ? null
        : utilities.map((scoped) => <SubprojectRow key={scoped.key} scoped={scoped} all={all} />)}
    </div>
  );
}
