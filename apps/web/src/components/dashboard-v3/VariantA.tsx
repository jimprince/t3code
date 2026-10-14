import { useMemo } from "react";

import { useDashboardUi } from "./context";
import {
  EAGER_PROJECTS,
  formatClock,
  orderProducts,
  outcomesSince,
  rollup,
  topLevelProjects,
} from "./dashboard.logic";
import { DecisionList } from "./decisions";
import { BarLegend, OutcomeRow, SectionHeading, SectionMarker, UnknownValue } from "./parts";
import { IdleProjects, ProjectGroup, ReleaseLines, UtilityGroup } from "./plan";

/** "last hour 13 steps · 2 stalled · 1 replanned": the Plan's totals, only from what was measured. */
function PlanTotals() {
  const { data } = useDashboardUi();
  const tasks = data.projects.flatMap((p) => p.project.tasks);
  const roll = rollup(tasks);
  const replanned = tasks.filter((task) => task.movement.state === "replanned").length;
  return (
    <>
      last hour{" "}
      {roll.gained === null ? (
        <UnknownValue>movement unknown</UnknownValue>
      ) : (
        <b className="font-medium text-foreground">{roll.gained} steps</b>
      )}
      {roll.idle > 0 ? ` · ${roll.idle} with no steps` : ""}
      {replanned > 0 ? ` · ${replanned} replanned` : ""}
    </>
  );
}

const DAY_MS = 86_400_000;

/** Finished since this device last looked, or in the last 24 hours on a first visit. */
function useOutcomes() {
  const { data, sinceLooked, now } = useDashboardUi();
  const since = sinceLooked?.baseline.at ?? new Date(now - DAY_MS).toISOString();
  return { since, firstVisit: sinceLooked === null, items: outcomesSince(data, since) };
}

/** Each outcome at the level it is known to have reached; the snapshot only knows closed. */
function OutcomeList({ limit }: { readonly limit?: number | undefined }) {
  const { data, now } = useDashboardUi();
  const { since, firstVisit, items } = useOutcomes();
  if (items.length === 0)
    return (
      <div className="py-1 text-muted-foreground/80">
        {firstVisit
          ? "Nothing finished in the last 24 hours"
          : `Nothing finished since ${formatClock(since, now)}`}
      </div>
    );
  const titleOf = (projectKey: string) =>
    data.projects.find((p) => p.key === projectKey)?.project.title ?? "";
  return (
    <div>
      {(limit ? items.slice(0, limit) : items).map((outcome) => (
        <OutcomeRow
          key={`${outcome.projectKey}|${outcome.task.id}`}
          title={outcome.task.title}
          level={`closed · ${titleOf(outcome.projectKey)}`}
          at={outcome.at}
        />
      ))}
    </div>
  );
}

function DoneHeading() {
  const { now } = useDashboardUi();
  const { since, firstVisit, items } = useOutcomes();
  return (
    <SectionHeading
      title={firstVisit ? "Done, last 24 hours" : `Done since ${formatClock(since, now)}`}
    >
      {items.length}
    </SectionHeading>
  );
}

/** A: the Plan on the left (releases, projects, workstreams, tasks), the one Decisions feed on the right. */
export function VariantA() {
  const { data, root, decisions, now } = useDashboardUi();
  const { utilities, ordered, idle } = useMemo(() => {
    const { products, utilities } = topLevelProjects(data.projects);
    return { utilities, ...orderProducts(products, data.projects) };
  }, [data.projects]);
  const groups = root ? [root] : ordered;
  const by = formatClock(
    new Date((data.asOf ? Date.parse(data.asOf) : now) + 3_600_000).toISOString(),
    now,
  );
  return (
    <div className="grid grid-cols-1 gap-x-6 @[60rem]/dash:grid-cols-[minmax(0,1fr)_360px] @[60rem]/dash:items-start">
      <div className="min-w-0">
        <SectionMarker name="releases" hidden={data.releases.length === 0}>
          {data.releases.length > 0 ? (
            <>
              <SectionHeading title={root ? "Release" : "Releases"} />
              <ReleaseLines />
            </>
          ) : null}
        </SectionMarker>
        <SectionMarker name="plan">
          <SectionHeading
            title="Plan"
            right={<BarLegend gainedLabel="last hour" byLabel={`by ${by}`} />}
          >
            <PlanTotals />
          </SectionHeading>
          {groups.length === 0 && idle.length === 0 && utilities.length === 0 ? (
            <div className="py-1 text-muted-foreground/80">No open work</div>
          ) : null}
          {groups.map((scoped, index) => (
            <ProjectGroup
              key={scoped.key}
              scoped={scoped}
              all={data.projects}
              showName={!root}
              eager={root !== null || index < EAGER_PROJECTS}
            />
          ))}
          {root ? null : <IdleProjects projects={idle} />}
        </SectionMarker>
        {root ? null : <UtilityGroup utilities={utilities} all={data.projects} />}
      </div>
      <aside className="min-w-0 @[60rem]/dash:sticky @[60rem]/dash:top-2">
        <SectionMarker name="decisions">
          <SectionHeading title="Decisions">
            <b className="font-medium text-foreground">{decisions.length}</b> open
          </SectionHeading>
          <DecisionList />
        </SectionMarker>
        <SectionMarker name="outcomes">
          <DoneHeading />
          <OutcomeList limit={8} />
        </SectionMarker>
      </aside>
    </div>
  );
}
