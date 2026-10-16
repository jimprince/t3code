import { orderPlan } from "@t3tools/client-runtime/dashboard/order";
import type { DashboardTask } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useDashboardUi } from "./context";
import {
  entryTasks,
  formatClock,
  formatEta,
  hasStepList,
  isDateOnlyEta,
  isEpicHeader,
  knownConfirmation,
  planNotes,
  nestWorkstreams,
  planWorkstreams,
  projectTasks,
  rollup,
  subprojectsOf,
  briefingWarningLabel,
  versionState,
  type PlanWorkstreamEntry,
  type ScopedProject,
} from "./dashboard.logic";
import { ActiveRow, PlanOrderProvider, QueuedRow, WorkstreamOrder } from "./orderRows";
import { WorkingLine } from "./WorkingLine";
import {
  NewMark,
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
        const eta = release.eta
          ? formatClock(release.eta, now)
          : roll?.ownerEta
            ? formatEta(roll.ownerEta, roll.ownerEtaDateOnly, now)
            : null;
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
                    {found && hasStepList(found.task) ? (
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
                    {eta ? <span>ETA {eta}</span> : null}
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

/** "#155" of an issue id such as `issue:host/owner/repo#155`. */
const issueRef = (id: string) => /#(\d+)$/.exec(id)?.[1];

/**
 * A header's right-hand figure. On the narrow layout it may wrap ("waiting on you" under the count) below a 90rem container
 * rather than starve the title of width.
 */
const HEADER_FIGURE = "inline-block text-right @max-[90rem]/dash:max-w-[14rem]";

const pluralize = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * A workstream's row and, when open, its tasks and the epics nested under it. Collapse is
 * remembered on this device. A tracker epic counts its child tasks (done/total children); every
 * other workstream sums its tasks' own steps. The two units are never added together.
 */
function WorkstreamRow({
  scoped,
  entry,
  title,
  openByDefault,
  onOpen,
  childOpenByDefault,
  ordering = false,
  number = null,
}: {
  readonly scoped: ScopedProject;
  readonly entry: PlanWorkstreamEntry;
  readonly title: string;
  readonly openByDefault: boolean;
  /** Makes the row a project heading: the name opens the project, only the caret collapses. */
  readonly onOpen?: (() => void) | undefined;
  /** Whether a nested workstream starts open. */
  readonly childOpenByDefault?: ((child: PlanWorkstreamEntry) => boolean) | undefined;
  /** The Plan's order is stored and editable: rows get handles, positions and a menu. */
  readonly ordering?: boolean | undefined;
  /** This workstream's place among the epics, shown beside its handle; null for any other group. */
  readonly number?: number | null | undefined;
}) {
  const ui = useDashboardUi();
  const { workstream, tasks, children, ownTask } = entry;
  const key = `ws:${scoped.key}|${workstream.id}`;
  const expandable = tasks.length > 0 || children.length > 0;
  const collapsed = ui.isCollapsed(key, !openByDefault);
  const epic = isEpicHeader(workstream);
  // A zero-total progress is no plan: it gets no bar and no 0/0, the same as no progress.
  const units =
    epic && workstream.progress && workstream.progress.total > 0 ? workstream.progress : null;
  const roll = rollup(tasks);
  // The decisions that block anything under this row, including the epic's own task and the
  // epics nested in it, so a collapsed row still carries the link.
  const keys = blockingKeys(ui.decisionKeysFor, scoped, entryTasks(entry));
  const progressSource = units
    ? [units.sourceId]
    : tasks.flatMap((t) => (hasStepList(t) ? [t.progress.sourceId] : []));
  const stale = progressSource.some((sourceId) => {
    const health = ui.sourceHealth(sourceId);
    return health === "stale" || health === "failed";
  });
  const since = stale
    ? [units?.confirmationKnown === false ? null : (units?.confirmedAt ?? null)]
        .concat(tasks.map((t) => (hasStepList(t) ? knownConfirmation(t.progress) : null)))
        .filter((v): v is string => !!v)
        .toSorted()[0]
    : undefined;
  const allDone = units
    ? units.total > 0 && units.done >= units.total
    : tasks.length > 0 && tasks.every((task) => task.status === "done");
  const tone = allDone ? "done" : keys.length > 0 || roll.idle > 0 ? "warning" : "default";
  const ref = epic ? issueRef(workstream.id) : undefined;
  const notes = planNotes(workstream.membershipWarnings);
  // The epic's own due date, from its kept task: a date, never a time.
  const ownEta = ownTask?.forecast ?? null;
  const ownEtaText = ownEta ? formatEta(ownEta.eta, isDateOnlyEta(ownEta), ui.now) : null;
  const unknownChildren = workstream.unknownChildIds?.length ?? 0;
  const titleClass = cn(
    "line-clamp-3 min-w-0 break-words text-left",
    onOpen ? "font-semibold" : "font-medium",
  );
  // An epic with nothing under it has nothing to collapse: its title is a heading, not a control.
  const titleButton =
    !expandable && ref ? (
      <span className={titleClass}>{title}</span>
    ) : (
      <button
        type="button"
        className={cn(titleClass, "hover:underline")}
        onClick={onOpen ?? (() => ui.toggleCollapsed(key))}
      >
        {title}
      </button>
    );
  const wrap = (header: ReactNode) =>
    ordering ? (
      <WorkstreamOrder entry={entry} number={number}>
        {header}
      </WorkstreamOrder>
    ) : (
      header
    );
  return (
    <div>
      {wrap(
        <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-0.75 @xl/dash:grid-cols-[14px_minmax(120px,1fr)_96px_minmax(110px,auto)]">
          {expandable ? (
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
          ) : (
            <span />
          )}
          {ref ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              {titleButton}
              <button
                type="button"
                aria-label={`Open issue #${ref}`}
                className="shrink-0 text-xs text-muted-foreground/70 hover:underline"
                onClick={() =>
                  ui.openTask(scoped, {
                    id: workstream.id,
                    url: workstream.url ?? null,
                    threadId: workstream.threadId ?? null,
                  })
                }
              >
                #{ref}
              </button>
              <NewMark item={workstream} />
            </span>
          ) : (
            titleButton
          )}
          <span className="order-last col-span-3 @xl/dash:order-none @xl/dash:col-span-1">
            {units ? (
              <ProgressBar
                steps={{ done: units.done, total: units.total }}
                gained={null}
                projectedDone={null}
                tone={tone}
                unknown={stale}
                unit="tasks"
              />
            ) : epic ? null : (
              <ProgressBar
                steps={roll.steps}
                gained={roll.gained}
                projectedDone={roll.projectedDone}
                tone={tone}
                unknown={stale}
              />
            )}
          </span>
          <span className="text-right">
            {stale ? (
              <span className={HEADER_FIGURE}>
                <UnknownValue since={since}>progress unknown</UnknownValue>{" "}
                <WaitingOnYou keys={keys} />
              </span>
            ) : units ? (
              <span className={HEADER_FIGURE}>
                <span className="tabular-nums whitespace-nowrap">
                  {units.done}/{units.total} tasks
                  {unknownChildren > 0 ? (
                    <span className="text-muted-foreground"> · {unknownChildren} unknown</span>
                  ) : null}
                </span>
                {ownEtaText ? (
                  <span className="whitespace-nowrap text-muted-foreground">
                    {" "}
                    · owner ETA {ownEtaText}
                  </span>
                ) : null}
                {keys.length > 0 ? (
                  <>
                    {" "}
                    <WaitingOnYou keys={keys} />
                  </>
                ) : null}
              </span>
            ) : epic ? (
              <span className={HEADER_FIGURE}>
                <span className="whitespace-nowrap text-muted-foreground/80">no tasks yet</span>
                {ownEtaText ? (
                  <span className="whitespace-nowrap text-muted-foreground/80">
                    {" "}
                    · owner ETA {ownEtaText}
                  </span>
                ) : null}{" "}
                <WaitingOnYou keys={keys} />
              </span>
            ) : (
              <ProgressFigure roll={roll} keys={keys} />
            )}
          </span>
        </div>,
      )}
      {notes.map((line) => (
        <div key={line} className="py-0.5 pl-6 text-xs text-muted-foreground">
          {line}
        </div>
      ))}
      <WorkingLine scoped={scoped} workers={workstream.workers} className="py-0.5 pl-6" />
      {collapsed ? null : (
        <>
          {ordering ? (
            <>
              {entry.now.map((task) => (
                <ActiveRow key={task.id} task={task} />
              ))}
              {entry.now.length > 0 && entry.next.length > 0 ? (
                <div className="py-0.5 pl-9 text-xs text-muted-foreground">Next, in order</div>
              ) : null}
              {entry.next.map((task, index) => (
                <QueuedRow key={task.id} task={task} entry={entry} position={index + 1} />
              ))}
              {entry.done.map((task) => (
                <div key={task.id} className="pl-6.5">
                  <TaskRow scoped={scoped} task={task} />
                </div>
              ))}
            </>
          ) : (
            tasks.map((task) => <TaskRow key={task.id} scoped={scoped} task={task} />)
          )}
          {children.length > 0 ? (
            <div className="pl-3.5">
              {children.map((child) => (
                <WorkstreamRow
                  key={child.workstream.id}
                  scoped={scoped}
                  entry={child}
                  title={child.workstream.title}
                  openByDefault={childOpenByDefault?.(child) ?? false}
                  childOpenByDefault={childOpenByDefault}
                  ordering={ordering}
                />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One line for a subproject or utility: its name, a bar over its own tasks, and the figure. */
function SubprojectRow({
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
    <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-0.75 @xl/dash:grid-cols-[14px_minmax(120px,1fr)_96px_minmax(110px,auto)]">
      <span />
      <button
        type="button"
        className={cn(
          "line-clamp-3 min-w-0 break-words text-left hover:underline",
          dim && "text-muted-foreground",
        )}
        onClick={() => ui.openProject(scoped)}
      >
        {scoped.project.title}
      </button>
      <span className="order-last col-span-3 @xl/dash:order-none @xl/dash:col-span-1">
        <ProgressBar
          small
          steps={roll.steps}
          gained={roll.gained}
          projectedDone={roll.projectedDone}
          tone={keys.length > 0 || roll.idle > 0 ? "warning" : "default"}
        />
      </span>
      <span className="text-right">
        {tasks.length === 0 && keys.length === 0 ? (
          <span className="text-muted-foreground/80">no open work</span>
        ) : tasks.length === 0 ? (
          <WaitingOnYou keys={keys} />
        ) : (
          <ProgressFigure roll={roll} keys={keys} />
        )}
      </span>
    </div>
  );
}

/**
 * Briefing files the server ignores because they claim the tracker but bind to no project. One
 * short line each, on Home only: such a file belongs to no project page.
 */
export function PlanWarnings() {
  const { data } = useDashboardUi();
  // The same warning read by two environments is one warning; two warnings on one file stay two.
  const warnings = [
    ...new Map(
      (data.planMigration ?? []).map((warning) => [briefingWarningLabel(warning), warning]),
    ).values(),
  ];
  if (warnings.length === 0) return null;
  return (
    <div className="pb-1">
      {warnings.map((warning) => (
        <div key={briefingWarningLabel(warning)} className="py-0.5 text-muted-foreground">
          {briefingWarningLabel(warning)}
        </div>
      ))}
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
  if (ui.order.canOrder(scoped))
    return <OrderedProjectGroup scoped={scoped} all={all} showName={showName} eager={eager} />;
  const subs = subprojectsOf(all, scoped).filter((sub) => sub.project.parentId === project.id);
  // This server does not store the order here: the plan reads as the snapshot lists it, with
  // every ask still in view.
  const workstreams = nestWorkstreams(planWorkstreams(project, orderPlan(project, false)));
  // "Work" is the server's placeholder when a workstream has no name of its own, and "Unsorted"
  // the tracker's group for asks with no epic. Neither gets a heading row when alone: a project
  // with nothing else shows its summary on the project row, otherwise the tasks list straight
  // under the project name.
  const unnamedTitle = (entry: PlanWorkstreamEntry) =>
    entry.workstream.title === "Work" ||
    (entry.workstream.title === "Unsorted" && workstreams.length === 1);
  const unnamed = workstreams.filter(unnamedTitle);
  const named = workstreams.filter((entry) => !unnamedTitle(entry));
  const merged = showName && named.length === 0 && unnamed.length === 1 ? unnamed[0]! : null;
  const looseTasks = merged ? [] : unnamed.flatMap((entry) => entry.tasks);
  const opensByDefault = (entry: PlanWorkstreamEntry) =>
    entryTasks(entry).some(
      (task) =>
        task.attentionIds.length > 0 ||
        (task.movement.state === "measured" && (task.movement.doneDelta ?? 0) > 0),
    );
  const omittedWorkstreams = project.omittedWorkstreamCount ?? 0;
  const migrated = project.planMigration?.removedTaskIds.length ?? 0;
  const name = (
    <button
      type="button"
      className="font-semibold hover:underline"
      onClick={() => ui.openProject(scoped)}
    >
      {project.title}
    </button>
  );
  const note = (text: ReactNode) => (
    <div className="py-0.5 pl-6 text-muted-foreground/80">{text}</div>
  );
  return (
    <div className="border-t border-border py-1.5 first:border-t-0">
      {merged ? (
        <WorkstreamRow
          scoped={scoped}
          entry={merged}
          title={project.title}
          openByDefault={eager}
          onOpen={() => ui.openProject(scoped)}
        />
      ) : showName ? (
        <div className="flex items-baseline gap-2 pb-1">{name}</div>
      ) : null}
      {migrated > 0
        ? note(
            `${migrated} ${pluralize(migrated, "row", "rows")} from the old plan file ${pluralize(migrated, "is", "are")} no longer shown`,
          )
        : null}
      {workstreams.length === 0 && subs.length === 0 && omittedWorkstreams === 0
        ? note(
            project.omittedTaskCount > 0
              ? `${project.omittedTaskCount} tasks not in this snapshot`
              : "No open work",
          )
        : null}
      {looseTasks.map((task) => (
        <TaskRow key={task.id} scoped={scoped} task={task} />
      ))}
      {named.map((entry) => (
        <WorkstreamRow
          key={entry.workstream.id}
          scoped={scoped}
          entry={entry}
          title={entry.workstream.title}
          openByDefault={eager && (named.length === 1 || opensByDefault(entry))}
          childOpenByDefault={(child) => eager && opensByDefault(child)}
        />
      ))}
      {omittedWorkstreams > 0
        ? note(
            `+${omittedWorkstreams} more ${pluralize(omittedWorkstreams, "workstream", "workstreams")} not in this snapshot`,
          )
        : null}
      {project.omittedTaskCount > 0 && workstreams.length > 0
        ? note(`+${project.omittedTaskCount} more tasks not in this snapshot`)
        : null}
      {subs.map((sub) => (
        <SubprojectRow key={sub.key} scoped={sub} all={all} dim />
      ))}
    </div>
  );
}

/**
 * A tracker project whose order is stored, in the one view. On a project page it lists the
 * numbered workstreams with their started and queued tasks; on Home it is compact: what is
 * moving, the first three queued, and how many new items wait to be ordered.
 */
function OrderedProjectGroup({
  scoped,
  all,
  showName,
  eager,
}: {
  readonly scoped: ScopedProject;
  readonly all: ReadonlyArray<ScopedProject>;
  readonly showName: boolean;
  readonly eager: boolean;
}) {
  const ui = useDashboardUi();
  const { project } = scoped;
  const plan = useMemo(() => orderPlan(project), [project]);
  const workstreams = useMemo(
    () => nestWorkstreams(planWorkstreams(project, plan)),
    [project, plan],
  );
  const subs = subprojectsOf(all, scoped).filter((sub) => sub.project.parentId === project.id);
  const omittedWorkstreams = project.omittedWorkstreamCount ?? 0;
  const epicNumbers = new Map(
    workstreams
      .filter((entry) => isEpicHeader(entry.workstream))
      .map((entry, index) => [entry.workstream.id, index + 1] as const),
  );
  const flat = workstreams.flatMap(function walk(entry): PlanWorkstreamEntry[] {
    return [entry, ...entry.children.flatMap(walk)];
  });
  const keys = blockingKeys(ui.decisionKeysFor, scoped, project.tasks);
  const note = (text: ReactNode) => (
    <div className="py-0.5 pl-6 text-muted-foreground/80">{text}</div>
  );
  return (
    <PlanOrderProvider scoped={scoped} entries={workstreams}>
      <div className="border-t border-border py-1.5 first:border-t-0">
        {showName ? (
          <div className="flex flex-wrap items-baseline gap-x-3 pb-1">
            <button
              type="button"
              className="font-semibold hover:underline"
              onClick={() => ui.openProject(scoped)}
            >
              {project.title}
            </button>
            {plan.fresh.length > 0 ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={() => ui.openProject(scoped)}
              >
                {plan.fresh.length} new to order
              </button>
            ) : null}
            <WaitingOnYou keys={keys} />
          </div>
        ) : null}
        {showName ? (
          <>
            {flat.flatMap((entry) =>
              entry.now.map((task) => <ActiveRow key={task.id} task={task} />),
            )}
            {flat
              .flatMap((entry) => entry.next.map((task) => ({ entry, task })))
              .slice(0, HOME_QUEUED)
              .map(({ entry, task }) => (
                <QueuedRow
                  key={task.id}
                  task={task}
                  entry={entry}
                  position={entry.next.indexOf(task) + 1}
                  compact
                />
              ))}
            {flat.every((entry) => entry.now.length + entry.next.length === 0)
              ? note(
                  project.omittedTaskCount > 0
                    ? `${project.omittedTaskCount} tasks not in this snapshot`
                    : "No open work",
                )
              : null}
          </>
        ) : (
          <>
            {workstreams.map((entry) => (
              <WorkstreamRow
                key={entry.workstream.id}
                scoped={scoped}
                entry={entry}
                title={isEpicHeader(entry.workstream) ? entry.workstream.title : "Other work"}
                openByDefault={eager}
                childOpenByDefault={() => eager}
                ordering
                number={epicNumbers.get(entry.workstream.id) ?? null}
              />
            ))}
            {workstreams.length === 0 && subs.length === 0 && omittedWorkstreams === 0
              ? note(
                  project.omittedTaskCount > 0
                    ? `${project.omittedTaskCount} tasks not in this snapshot`
                    : "No open work",
                )
              : null}
            {omittedWorkstreams > 0
              ? note(
                  `+${omittedWorkstreams} more ${pluralize(omittedWorkstreams, "workstream", "workstreams")} not in this snapshot`,
                )
              : null}
            {project.omittedTaskCount > 0 && workstreams.length > 0
              ? note(`+${project.omittedTaskCount} more tasks not in this snapshot`)
              : null}
          </>
        )}
        {subs.map((sub) => (
          <SubprojectRow key={sub.key} scoped={sub} all={all} dim />
        ))}
      </div>
    </PlanOrderProvider>
  );
}

/** How many queued rows a project shows on Home. */
const HOME_QUEUED = 3;

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
