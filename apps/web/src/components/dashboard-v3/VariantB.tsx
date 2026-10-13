import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { useDashboardUi } from "./context";
import {
  formatClock,
  projectTasks,
  rollup,
  topLevelProjects,
  workstreamTasks,
  type Change,
  type ChangeKind,
} from "./dashboard.logic";
import { DecisionList } from "./decisions";
import { BarLegend, ProgressBar, ProgressFigure, SectionHeading, UnknownValue } from "./parts";
import { ReleaseLines } from "./plan";
import { InlineButton } from "../ui/button";

const KIND_MARK: Record<ChangeKind, { mark: string; className: string }> = {
  done: { mark: "✓", className: "text-success" },
  steps: { mark: "↑", className: "text-info" },
  replanned: { mark: "↻", className: "text-muted-foreground" },
  "decision-new": { mark: "?", className: "text-warning-foreground" },
};

/** How many step advances show before the rest fold behind "Show". */
const STEP_ROWS = 8;

function ChangeLog() {
  const { sinceLooked, data, now } = useDashboardUi();
  const [all, setAll] = useState(false);
  if (!sinceLooked)
    return (
      <div className="py-1">
        <UnknownValue>nothing to compare yet</UnknownValue>
      </div>
    );
  const since = formatClock(sinceLooked.baseline.at, now);
  const { changes } = sinceLooked;
  if (changes.length === 0)
    return <div className="py-1 text-muted-foreground/80">No changes since {since}</div>;
  const steps = changes.filter((change) => change.kind === "steps");
  const hidden = all ? 0 : Math.max(0, steps.length - STEP_ROWS);
  const shownSteps = new Set(all ? steps : steps.slice(0, STEP_ROWS));
  const visible = changes.filter((change) => change.kind !== "steps" || shownSteps.has(change));
  const titleOf = (change: Change) =>
    data.projects.find((p) => p.key === change.projectKey)?.project.title ?? "";
  return (
    <div className="flex flex-col text-xs">
      {visible.map((change) => {
        const { mark, className } = KIND_MARK[change.kind];
        return (
          <div
            key={`${change.projectKey}|${change.taskId}|${change.kind}|${change.text}`}
            className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 py-0.5"
          >
            <span className={className}>
              {mark === "✓" ? <CheckIcon className="size-3.5" /> : mark}
            </span>
            <span>
              {change.kind === "decision-new" ? "New decision " : ""}
              {change.text} <span className="text-muted-foreground">{titleOf(change)}</span>
            </span>
          </div>
        );
      })}
      {hidden > 0 ? (
        <div className="pl-6 text-muted-foreground">
          +{hidden} smaller step changes{" "}
          <InlineButton tone="muted" onClick={() => setAll(true)}>
            Show
          </InlineButton>
        </div>
      ) : null}
    </div>
  );
}

/** One bar per project (Home) or workstream (project page): the plan and the forecast, compactly. */
function NowStrip() {
  const ui = useDashboardUi();
  const { data, root } = ui;
  const { products, utilities } = topLevelProjects(data.projects);
  const rows = root
    ? [
        ...root.project.workstreams.map((workstream) => ({
          key: `${root.key}|${workstream.id}`,
          name: workstream.title,
          tasks: workstreamTasks(root.project, workstream),
          scoped: root,
        })),
        ...data.projects
          .filter((p) => p !== root)
          .map((scoped) => ({
            key: scoped.key,
            name: scoped.project.title,
            tasks: projectTasks(data.projects, scoped),
            scoped,
          })),
      ]
    : [
        ...products.map((scoped) => ({
          key: scoped.key,
          name: scoped.project.title,
          tasks: projectTasks(data.projects, scoped),
          scoped,
        })),
        ...(utilities.length > 0
          ? [
              {
                key: "utilities",
                name: "Utilities",
                tasks: utilities.flatMap((scoped) => projectTasks(data.projects, scoped)),
                scoped: utilities[0]!,
              },
            ]
          : []),
      ];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[150px_minmax(0,1fr)_230px]">
      {rows.map((row) => {
        const roll = rollup(row.tasks);
        const keys = [
          ...new Set(row.tasks.flatMap((task) => ui.decisionKeysFor(row.scoped, task))),
        ];
        return (
          <div key={row.key} className="contents">
            <span className="truncate font-medium">{row.name}</span>
            <span className="order-last col-span-2 sm:order-none sm:col-span-1">
              <ProgressBar
                steps={roll.steps}
                gained={roll.gained}
                projectedDone={roll.projectedDone}
                tone={keys.length > 0 || roll.idle > 0 ? "warning" : "default"}
              />
            </span>
            <span className="text-right sm:text-left">
              {row.tasks.length === 0 ? (
                <span className="text-muted-foreground/80">no open work</span>
              ) : (
                <ProgressFigure roll={roll} keys={keys} />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** B: the morning review. Decisions first, then what changed since this device last looked. */
export function VariantB() {
  const { data, decisions, now, sinceLooked } = useDashboardUi();
  const by = formatClock(
    new Date((data.asOf ? Date.parse(data.asOf) : now) + 3_600_000).toISOString(),
    now,
  );
  return (
    <div>
      {data.releases.length > 0 ? (
        <>
          <SectionHeading title="Releases" />
          <ReleaseLines />
        </>
      ) : null}
      <SectionHeading
        title={`Now and by ${by}`}
        right={<BarLegend gainedLabel="last hour" byLabel="next hour" />}
      />
      <NowStrip />
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-[400px_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0">
          <SectionHeading title="Decisions">
            <b className="font-medium text-foreground">{decisions.length}</b> open
          </SectionHeading>
          <DecisionList />
        </div>
        <div className="min-w-0">
          <SectionHeading
            title={
              sinceLooked ? `Changes since ${formatClock(sinceLooked.baseline.at, now)}` : "Changes"
            }
          >
            {sinceLooked ? (
              <>
                <b className="font-medium text-foreground">{sinceLooked.outcomes.length} done</b> ·{" "}
                {sinceLooked.changes.filter((c) => c.kind === "steps").length} step advances
              </>
            ) : null}
          </SectionHeading>
          <ChangeLog />
        </div>
      </div>
    </div>
  );
}
