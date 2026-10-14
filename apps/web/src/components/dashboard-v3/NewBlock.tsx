import { issueNumber, orderPlan } from "@t3tools/client-runtime/dashboard/order";
import type { DashboardTask } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { InlineButton } from "../ui/button";
import { useDashboardUi } from "./context";
import { ageLabel, nestWorkstreams, planWorkstreams, type ScopedProject } from "./dashboard.logic";
import { PlanOrderProvider, RowMenu, usePlanDestinations } from "./orderRows";
import { NewMark, SectionHeading } from "./parts";

/** How many New rows show before "N older". */
const SHOWN = 7;

/** Do next and Last put the item in the workstream its Part of line names, or in Other work. */
function PlaceNew({
  scoped,
  task,
  to,
  label,
}: {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
  readonly to: "top" | "bottom";
  readonly label: string;
}) {
  const ui = useDashboardUi();
  const { destinationFor } = usePlanDestinations();
  return (
    <InlineButton
      tone="muted"
      onClick={() => {
        const destination = destinationFor(task);
        void ui.order.place(scoped, task, {
          destination,
          list: destination.next,
          move: { to },
          origin: [],
        });
      }}
    >
      {label}
    </InlineButton>
  );
}

function NewRow({
  scoped,
  task,
}: {
  readonly scoped: ScopedProject;
  readonly task: DashboardTask;
}) {
  const ui = useDashboardUi();
  const { destinationFor } = usePlanDestinations();
  const number = issueNumber(task.id);
  return (
    <div data-testid="new-row" className="flex items-baseline gap-x-2.5 py-0.5 pl-1 text-xs">
      <button
        type="button"
        className="line-clamp-2 min-w-0 flex-1 break-words text-left hover:underline"
        onClick={() => ui.openTask(scoped, task)}
      >
        {task.title}
        {number ? <span className="ml-1 text-muted-foreground/70">#{number}</span> : null}
        {task.bug ? <span className="ml-1.5 text-destructive-foreground">bug</span> : null}
        <NewMark item={task} />
      </button>
      <span className="hidden shrink-0 text-muted-foreground @xl/dash:inline">
        {task.partOf ? `${destinationFor(task).title} · ` : ""}
        {task.createdAt ? ageLabel(task.createdAt, ui.now) : ""}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <PlaceNew scoped={scoped} task={task} to="top" label="Do next" />
        <PlaceNew scoped={scoped} task={task} to="bottom" label="Last" />
        <RowMenu task={task} entry={null} where="new" />
      </span>
    </div>
  );
}

/**
 * "New, not ordered": filed items with no place yet, newest first, each one click from a place.
 * Brad decides here where the agents' uncertain filings go. Later is only a count.
 */
export function NewBlock({ scoped }: { readonly scoped: ScopedProject }) {
  const ui = useDashboardUi();
  const [all, setAll] = useState(false);
  const plan = useMemo(() => orderPlan(scoped.project), [scoped.project]);
  const entries = useMemo(
    () => nestWorkstreams(planWorkstreams(scoped.project, plan)),
    [scoped.project, plan],
  );
  if (!ui.order.canOrder(scoped) || (plan.fresh.length === 0 && plan.later === 0)) return null;
  const rows = all ? plan.fresh : plan.fresh.slice(0, SHOWN);
  return (
    <PlanOrderProvider scoped={scoped} entries={entries}>
      <div data-testid="new-block">
        <SectionHeading title="New, not ordered">
          <span className="tabular-nums">{plan.fresh.length}</span>
          {plan.later > 0 ? <span className="tabular-nums"> · Later {plan.later}</span> : null}
        </SectionHeading>
        {rows.map((task) => (
          <NewRow key={task.id} scoped={scoped} task={task} />
        ))}
        {plan.fresh.length > SHOWN ? (
          <div className="py-0.5 pl-1 text-xs">
            <InlineButton tone="muted" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `${plan.fresh.length - SHOWN} older`}
            </InlineButton>
          </div>
        ) : null}
      </div>
    </PlanOrderProvider>
  );
}
