import type { DashboardTask } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { useDashboardUi } from "./context";
import {
  ageLabel,
  formatClock,
  newestConfirmation,
  projectTasks,
  rollup,
  topLevelProjects,
  workstreamTasks,
  type ScopedProject,
} from "./dashboard.logic";
import { DoneHeading, OutcomeList } from "./VariantA";
import { ProgressBar, releaseTask, UnknownValue, WaitingOnYou } from "./parts";
import { SectionHeading } from "./parts";
import { DecisionCard } from "./decisions";

const TH =
  "border-b border-border py-1 pr-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const TD = "border-b border-border/60 py-0.75 pr-2 align-middle";

/** One grid row. Every row answers the same columns; a missing fact is unknown, never zero. */
function GridRow({
  scoped,
  tasks,
  title,
  indent = 0,
  caret,
  hot = false,
}: {
  readonly scoped: ScopedProject;
  readonly tasks: ReadonlyArray<DashboardTask>;
  readonly title: ReactNode;
  readonly indent?: number;
  readonly caret?: { readonly collapsed: boolean; readonly toggle: () => void } | undefined;
  readonly hot?: boolean;
}) {
  const ui = useDashboardUi();
  const { now } = ui;
  const roll = rollup(tasks);
  const keys = [...new Set(tasks.flatMap((task) => ui.decisionKeysFor(scoped, task)))];
  const confirmed = newestConfirmation(tasks);
  const stale = tasks.some((task) => {
    const health = task.progress ? ui.sourceHealth(task.progress.sourceId) : null;
    return health === "stale" || health === "failed";
  });
  const next = tasks.find((task) => task.status !== "done" && task.nextStep)?.nextStep ?? null;
  const allDone = tasks.length > 0 && tasks.every((task) => task.status === "done");
  const attention = keys.length > 0 || roll.idle > 0;
  const unstickTitle = tasks.length === 1 ? tasks[0]!.title : scoped.project.title;
  return (
    <tr className={cn((hot || attention) && "bg-warning-surface")}>
      <td className={TD} style={{ paddingLeft: indent * 14 }}>
        <span className="inline-flex items-center gap-1">
          {caret ? (
            <button
              type="button"
              aria-expanded={!caret.collapsed}
              aria-label={caret.collapsed ? "Expand" : "Collapse"}
              className="text-muted-foreground/70"
              onClick={caret.toggle}
            >
              {caret.collapsed ? (
                <ChevronRightIcon className="size-3" />
              ) : (
                <ChevronDownIcon className="size-3" />
              )}
            </button>
          ) : (
            <span className="inline-block w-3" />
          )}
          {title}
        </span>
      </td>
      <td className={cn(TD, "min-w-[90px] w-[16%]")}>
        <ProgressBar
          small
          steps={roll.steps}
          gained={roll.gained}
          projectedDone={roll.projectedDone}
          tone={allDone ? "done" : attention ? "warning" : "default"}
          unknown={stale}
        />
      </td>
      <td className={cn(TD, "text-right tabular-nums")}>
        {stale ? (
          <UnknownValue>?</UnknownValue>
        ) : roll.steps ? (
          `${roll.steps.done}/${roll.steps.total}`
        ) : (
          <span className="text-muted-foreground/60">·</span>
        )}
      </td>
      <td className={cn(TD, "text-right tabular-nums")}>
        {roll.gained === null ? (
          <UnknownValue>?</UnknownValue>
        ) : roll.gained > 0 ? (
          <span className="text-info">+{roll.gained}</span>
        ) : (
          <span className="text-muted-foreground/60">0</span>
        )}
      </td>
      <td className={cn(TD, "hidden text-right tabular-nums sm:table-cell")}>
        {roll.steps && roll.projectedDone !== null && roll.paceBasis ? (
          `~${roll.projectedDone}/${roll.steps.total}`
        ) : (
          <span className="text-muted-foreground/60">·</span>
        )}
      </td>
      <td className={cn(TD, "hidden max-w-[160px] truncate text-muted-foreground sm:table-cell")}>
        {next}
      </td>
      <td className={cn(TD, "hidden tabular-nums whitespace-nowrap sm:table-cell")}>
        {roll.ownerEta ? (
          <>
            {formatClock(roll.ownerEta, now)}{" "}
            <span className="text-muted-foreground/70">owner</span>
          </>
        ) : roll.steps ? (
          <UnknownValue />
        ) : null}
      </td>
      <td className={cn(TD, "whitespace-nowrap")}>
        {keys.length > 0 ? <WaitingOnYou keys={keys} /> : null}
        {roll.idle > 0 ? (
          <>
            <span className="text-warning-foreground"> no steps this hour </span>
            <Button size="micro" variant="ghost-muted" onClick={() => ui.unstick(unstickTitle)}>
              Unstick
            </Button>
          </>
        ) : null}
      </td>
      <td className={cn(TD, "hidden text-right tabular-nums sm:table-cell")}>
        {confirmed ? (
          <span
            className={
              now - Date.parse(confirmed) > 3_600_000
                ? "text-warning-foreground"
                : "text-muted-foreground/70"
            }
          >
            {ageLabel(confirmed, now)}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function GroupRow({ children }: { readonly children: ReactNode }) {
  return (
    <tr>
      <td colSpan={9} className="border-b border-border pt-2.5 pb-0.5 font-semibold">
        {children}
      </td>
    </tr>
  );
}

function ProjectRows({
  scoped,
  all,
  showName,
}: {
  readonly scoped: ScopedProject;
  readonly all: ReadonlyArray<ScopedProject>;
  readonly showName: boolean;
}) {
  const ui = useDashboardUi();
  const { project } = scoped;
  const subs = all.filter(
    (candidate) =>
      candidate.environmentId === scoped.environmentId && candidate.project.parentId === project.id,
  );
  return (
    <>
      {showName ? (
        <GroupRow>
          <button type="button" className="hover:underline" onClick={() => ui.openProject(scoped)}>
            {project.title}
          </button>
        </GroupRow>
      ) : null}
      {project.workstreams.map((workstream) => {
        const tasks = workstreamTasks(project, workstream);
        if (tasks.length === 0) return null;
        const key = `ws:${scoped.key}|${workstream.id}`;
        const open =
          tasks.some((task) => task.attentionIds.length > 0) || project.workstreams.length === 1;
        const collapsed = ui.isCollapsed(key, !open);
        return (
          <WorkstreamRows
            key={workstream.id}
            scoped={scoped}
            title={workstream.title}
            tasks={tasks}
            collapsed={collapsed}
            toggle={() => ui.toggleCollapsed(key)}
          />
        );
      })}
      {subs.map((sub) => (
        <GridRow
          key={sub.key}
          scoped={sub}
          tasks={projectTasks(all, sub)}
          indent={1}
          title={
            <button
              type="button"
              className="text-muted-foreground hover:underline"
              onClick={() => ui.openProject(sub)}
            >
              {sub.project.title} <span className="text-muted-foreground/60">subproject</span>
            </button>
          }
        />
      ))}
    </>
  );
}

function WorkstreamRows({
  scoped,
  title,
  tasks,
  collapsed,
  toggle,
}: {
  readonly scoped: ScopedProject;
  readonly title: string;
  readonly tasks: ReadonlyArray<DashboardTask>;
  readonly collapsed: boolean;
  readonly toggle: () => void;
}) {
  const ui = useDashboardUi();
  return (
    <>
      <GridRow
        scoped={scoped}
        tasks={tasks}
        title={<span className="font-medium">{title}</span>}
        caret={{ collapsed, toggle }}
      />
      {collapsed
        ? null
        : tasks.map((task) => (
            <GridRow
              key={task.id}
              scoped={scoped}
              tasks={[task]}
              indent={1}
              title={
                <button
                  type="button"
                  className={cn(
                    "truncate text-left hover:underline",
                    task.status === "pending" && "text-muted-foreground",
                  )}
                  onClick={() => ui.openTask(scoped, task)}
                >
                  {task.status === "done" ? <span className="text-success">✓ </span> : null}
                  {task.title}
                </button>
              }
            />
          ))}
    </>
  );
}

/** C: one dense, sortable-by-eye table; decisions and Done sit under it as short lists. */
export function VariantC() {
  const ui = useDashboardUi();
  const { data, root, decisions } = ui;
  const { products, utilities } = topLevelProjects(data.projects);
  const groups = root ? [root] : products;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-0 border-collapse text-xs sm:min-w-[900px]">
          <thead>
            <tr>
              <th className={TH}>Work</th>
              <th className={TH}>Progress</th>
              <th className={cn(TH, "text-right")}>Done</th>
              <th className={cn(TH, "text-right")}>1h</th>
              <th className={cn(TH, "hidden text-right sm:table-cell")}>By next hour</th>
              <th className={cn(TH, "hidden sm:table-cell")}>Next</th>
              <th className={cn(TH, "hidden sm:table-cell")}>ETA</th>
              <th className={TH}>Needs you / blocker</th>
              <th className={cn(TH, "hidden text-right sm:table-cell")}>Age</th>
            </tr>
          </thead>
          <tbody>
            {data.releases.length > 0 ? <GroupRow>{root ? "Release" : "Releases"}</GroupRow> : null}
            {data.releases.map(({ environmentId, release }) => {
              const found = releaseTask(data.projects, release);
              return (
                <GridRow
                  key={`${environmentId}:${release.id}`}
                  scoped={found?.scoped ?? data.projects[0]!}
                  tasks={found ? [found.task] : []}
                  title={
                    <span>
                      {release.title}{" "}
                      <span className="text-muted-foreground/70">{release.phase ?? ""}</span>
                    </span>
                  }
                />
              );
            })}
            {groups.map((scoped) => (
              <ProjectRows key={scoped.key} scoped={scoped} all={data.projects} showName={!root} />
            ))}
            {!root && utilities.length > 0 ? <GroupRow>Utilities</GroupRow> : null}
            {root
              ? null
              : utilities.map((scoped) => (
                  <GridRow
                    key={scoped.key}
                    scoped={scoped}
                    tasks={projectTasks(data.projects, scoped)}
                    title={<span>{scoped.project.title}</span>}
                  />
                ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <SectionHeading title="Decisions">
            <b className="font-medium text-foreground">{decisions.length}</b> open
          </SectionHeading>
          {decisions.length === 0 ? (
            <div className="py-1 text-muted-foreground/80">Nothing needs you</div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {decisions.map((row) => (
                <DecisionCard key={row.key} row={row} />
              ))}
            </div>
          )}
        </div>
        <div>
          <DoneHeading />
          <OutcomeList />
        </div>
      </div>
    </div>
  );
}
