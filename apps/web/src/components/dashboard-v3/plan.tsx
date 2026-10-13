import type { DashboardTask } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useDashboardUi } from "./context";
import {
  formatClock,
  projectTasks,
  rollup,
  subprojectsOf,
  planWorkstreams,
  versionState,
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
 * Releases (R10): where the release stands, when it lands, and installed against latest, in one or
 * two lines each. A line shows only the facts the snapshot has; the rest is left out or marked
 * unknown. When a release's source is stale or failed, its phase, ETA and nightly lag read as
 * unknown since the source's last success rather than as current.
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
        const health = ui.sourceHealth(release.sourceId);
        const stale = health === "stale" || health === "failed";
        const since = ui.sourceLastSuccessAt(release.sourceId);
        const version = versionState(release.installedVersion, release.latestVersion);
        const hasVersions = release.installedVersion !== null || release.latestVersion !== null;
        const hasLag = lag !== undefined && lag !== null;
        return (
          <div key={`${environmentId}:${release.id}`} className="flex flex-col gap-0.5 py-1.5">
            <div className="flex items-baseline gap-x-3">
              <span className="min-w-0 flex-1 font-semibold break-words">{release.title}</span>
              <span className="flex flex-wrap items-baseline justify-end gap-x-3 text-right tabular-nums">
                {stale ? (
                  <UnknownValue since={since}>phase and ETA unknown</UnknownValue>
                ) : (
                  <>
                    {release.phase ? <span>{release.phase}</span> : null}
                    {found?.task.progress ? (
                      <>
                        <span>
                          {found.task.progress.done}/{found.task.progress.total}
                          {roll?.gained ? <span className="text-info"> +{roll.gained}</span> : null}
                        </span>
                        <span className="w-24 self-center">
                          <ProgressBar
                            small
                            steps={{
                              done: found.task.progress.done,
                              total: found.task.progress.total,
                            }}
                            gained={roll?.gained ?? null}
                            projectedDone={roll?.projectedDone ?? null}
                            tone={keys.length > 0 ? "warning" : "default"}
                          />
                        </span>
                      </>
                    ) : null}
                    {eta ? <span>ETA {formatClock(eta, now)}</span> : null}
                  </>
                )}
                <WaitingOnYou keys={keys} />
              </span>
            </div>
            {hasVersions || hasLag ? (
              <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                {hasVersions ? (
                  <span>
                    <span className={cn(version === "behind" && "text-warning-foreground")}>
                      {release.installedVersion ?? <UnknownValue />}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      installed · latest {release.latestVersion ?? <UnknownValue />}
                    </span>
                    {version === "current" ? <span className="text-success"> ✓</span> : null}
                  </span>
                ) : null}
                {hasLag ? (
                  <span>
                    {stale ? (
                      <UnknownValue since={since}>nightly lag unknown</UnknownValue>
                    ) : (
                      <span className={lag > 0 ? "text-destructive-foreground" : "text-success"}>
                        nightlies{" "}
                        {lag > 0 ? `${lag} ${lag === 1 ? "day" : "days"} behind` : "caught up"}
                      </span>
                    )}
                    {release.nightlySync ? <span>, sync {release.nightlySync}</span> : null}
                    <span className="text-muted-foreground"> · catch-up </span>
                    <UnknownValue />
                  </span>
                ) : null}
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
  onOpen,
}: {
  readonly scoped: ScopedProject;
  readonly workstreamId: string;
  readonly title: string;
  readonly tasks: ReadonlyArray<DashboardTask>;
  readonly openByDefault: boolean;
  /** Makes the row a project heading: the name opens the project, only the caret collapses. */
  readonly onOpen?: (() => void) | undefined;
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
      <div
        className={cn(
          "grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-0.75",
          onOpen
            ? "sm:grid-cols-[14px_minmax(220px,1.4fr)_minmax(90px,1fr)_minmax(170px,auto)]"
            : "sm:grid-cols-[14px_minmax(150px,1.25fr)_minmax(110px,1.6fr)_minmax(170px,auto)]",
        )}
      >
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
          className={cn(
            "min-w-0 truncate text-left hover:underline",
            onOpen ? "font-semibold" : "font-medium",
          )}
          onClick={onOpen ?? (() => ui.toggleCollapsed(key))}
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
  eager = true,
}: {
  readonly scoped: ScopedProject;
  readonly all: ReadonlyArray<ScopedProject>;
  readonly showName?: boolean;
  /** Open workstreams by default; off for the projects below the first screen on Home. */
  readonly eager?: boolean;
}) {
  const ui = useDashboardUi();
  const { project } = scoped;
  const subs = subprojectsOf(all, scoped).filter((sub) => sub.project.parentId === project.id);
  const workstreams = planWorkstreams(project);
  // "Work" is the server's placeholder when a workstream has no name of its own, so it gets no
  // heading row: a project with nothing else shows its summary on the project row, otherwise the
  // tasks list straight under the project name.
  const unnamed = workstreams.filter((entry) => entry.workstream.title === "Work");
  const named = workstreams.filter((entry) => entry.workstream.title !== "Work");
  const merged = showName && named.length === 0 && unnamed.length === 1 ? unnamed[0]! : null;
  const looseTasks = merged ? [] : unnamed.flatMap((entry) => entry.tasks);
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
      {merged ? (
        <WorkstreamRow
          scoped={scoped}
          workstreamId={merged.workstream.id}
          title={project.title}
          tasks={merged.tasks}
          openByDefault={eager}
          onOpen={() => ui.openProject(scoped)}
        />
      ) : showName ? (
        <div className="flex items-baseline gap-2 pb-1">{name}</div>
      ) : null}
      {workstreams.length === 0 && subs.length === 0 ? (
        <div className="py-0.5 pl-6 text-muted-foreground/80">
          {project.omittedTaskCount > 0
            ? `${project.omittedTaskCount} tasks not in this snapshot`
            : "No open work"}
        </div>
      ) : null}
      {looseTasks.map((task) => (
        <TaskRow key={task.id} scoped={scoped} task={task} />
      ))}
      {named.map(({ workstream, tasks }) => (
        <WorkstreamRow
          key={workstream.id}
          scoped={scoped}
          workstreamId={workstream.id}
          title={workstream.title}
          tasks={tasks}
          openByDefault={
            eager &&
            (named.length === 1 ||
              tasks.some(
                (task) =>
                  task.attentionIds.length > 0 ||
                  (task.movement.state === "measured" && (task.movement.doneDelta ?? 0) > 0),
              ))
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

/** Projects with no tasks at all, as one trailing line instead of a "No open work" block each. */
export function IdleProjects({ projects }: { readonly projects: ReadonlyArray<ScopedProject> }) {
  const ui = useDashboardUi();
  if (projects.length === 0) return null;
  return (
    <div className="border-t border-border py-1.5 text-muted-foreground">
      Idle:{" "}
      {projects.map((scoped, index) => (
        <span key={scoped.key}>
          {index > 0 ? ", " : ""}
          <button type="button" className="hover:underline" onClick={() => ui.openProject(scoped)}>
            {scoped.project.title}
          </button>
        </span>
      ))}
    </div>
  );
}
