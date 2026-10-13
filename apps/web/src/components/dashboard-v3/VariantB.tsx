import type { DashboardTask } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useDashboardUi } from "./context";
import {
  firstVisitChanges,
  formatClock,
  projectTasks,
  rollup,
  orderProducts,
  planWorkstreams,
  topLevelProjects,
  type Change,
  type ChangeKind,
  type ScopedProject,
} from "./dashboard.logic";
import { DecisionList } from "./decisions";
import { BarLegend, ProgressBar, ProgressFigure, SectionHeading, SectionMarker } from "./parts";
import { IdleProjects, ReleaseLines } from "./plan";
import { InlineButton } from "../ui/button";

const KIND_MARK: Record<ChangeKind, { mark: string; className: string }> = {
  done: { mark: "✓", className: "text-success" },
  steps: { mark: "↑", className: "text-info" },
  replanned: { mark: "↻", className: "text-muted-foreground" },
  "decision-new": { mark: "?", className: "text-warning-foreground" },
};

/** How many step advances show before the rest fold behind "Show". */
const STEP_ROWS = 8;

const DAY_MS = 86_400_000;

/**
 * What the log lists: the changes since this device last looked, or on a first visit, when there
 * is nothing to compare, the last 24 hours of finished work and every open decision.
 */
function useChangeLog() {
  const { sinceLooked, data, now } = useDashboardUi();
  return useMemo(
    () => ({
      since: sinceLooked ? sinceLooked.baseline.at : null,
      changes: sinceLooked
        ? sinceLooked.changes
        : firstVisitChanges(data, new Date(now - DAY_MS).toISOString()),
    }),
    [data, now, sinceLooked],
  );
}

function ChangeLog() {
  const { data, now } = useDashboardUi();
  const { since: sinceAt, changes } = useChangeLog();
  const [all, setAll] = useState(false);
  if (changes.length === 0)
    return (
      <div className="py-1 text-muted-foreground/80">
        {sinceAt
          ? `No changes since ${formatClock(sinceAt, now)}`
          : "Nothing finished in the last 24 hours"}
      </div>
    );
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

interface NowRow {
  readonly key: string;
  readonly name: string;
  readonly tasks: ReadonlyArray<DashboardTask>;
  readonly scoped: ScopedProject;
}

/**
 * The strip's rows: one per project on Home (Utilities as one row of their own, so it can carry its
 * own section marker), one per workstream and nested project on a project page.
 */
function useNowRows(): {
  readonly plan: ReadonlyArray<NowRow>;
  readonly idle: ReadonlyArray<ScopedProject>;
  readonly utilities: NowRow | null;
} {
  const { data, root } = useDashboardUi();
  return useMemo(() => {
    if (root)
      return {
        plan: [
          ...planWorkstreams(root.project).map(({ workstream, tasks }) => ({
            key: `${root.key}|${workstream.id}`,
            name: workstream.title,
            tasks,
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
        ],
        idle: [],
        utilities: null,
      };
    const { products, utilities } = topLevelProjects(data.projects);
    const { ordered, idle } = orderProducts(products, data.projects);
    return {
      idle,
      plan: ordered.map((scoped) => ({
        key: scoped.key,
        name: scoped.project.title,
        tasks: projectTasks(data.projects, scoped),
        scoped,
      })),
      utilities:
        utilities.length > 0
          ? {
              key: "utilities",
              name: "Utilities",
              tasks: utilities.flatMap((scoped) => projectTasks(data.projects, scoped)),
              scoped: utilities[0]!,
            }
          : null,
    };
  }, [data.projects, root]);
}

/** One bar per project (Home) or workstream (project page): the plan and the forecast, compactly. */
function NowStrip({ rows }: { readonly rows: ReadonlyArray<NowRow> }) {
  const ui = useDashboardUi();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[150px_minmax(0,1fr)_minmax(230px,auto)]">
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
  const { data, decisions, now, root } = useDashboardUi();
  const { since, changes } = useChangeLog();
  const rows = useNowRows();
  const by = formatClock(
    new Date((data.asOf ? Date.parse(data.asOf) : now) + 3_600_000).toISOString(),
    now,
  );
  const done = changes.filter((change) => change.kind === "done").length;
  return (
    <div>
      <SectionMarker name="releases" hidden={data.releases.length === 0}>
        {data.releases.length > 0 ? (
          <>
            <SectionHeading title="Releases" />
            <ReleaseLines />
          </>
        ) : null}
      </SectionMarker>
      <SectionMarker name="plan">
        <SectionHeading
          title={`Now and by ${by}`}
          right={<BarLegend gainedLabel="last hour" byLabel="next hour" />}
        />
        <NowStrip rows={rows.plan} />
        <IdleProjects projects={rows.idle} />
      </SectionMarker>
      {root ? null : (
        <SectionMarker name="utilities" hidden={rows.utilities === null}>
          {rows.utilities ? <NowStrip rows={[rows.utilities]} /> : null}
        </SectionMarker>
      )}
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-[400px_minmax(0,1fr)] lg:items-start">
        <SectionMarker name="decisions" className="min-w-0">
          <SectionHeading title="Decisions">
            <b className="font-medium text-foreground">{decisions.length}</b> open
          </SectionHeading>
          <DecisionList />
        </SectionMarker>
        <SectionMarker name="outcomes" className="min-w-0">
          <SectionHeading
            title={since ? `Changes since ${formatClock(since, now)}` : "Last 24 hours"}
          >
            <b className="font-medium text-foreground">{done} done</b>
            {since ? (
              <> · {changes.filter((change) => change.kind === "steps").length} step advances</>
            ) : null}
          </SectionHeading>
          <ChangeLog />
        </SectionMarker>
      </div>
    </div>
  );
}
