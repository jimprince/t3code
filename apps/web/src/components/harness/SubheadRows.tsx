import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  summarizeSubheadGroup,
  type SubheadGroup as SubheadGroupView,
  type SubheadRowView,
  type SubheadTone,
} from "@t3tools/client-runtime/state/subheads-view";
import { formatLocalWhen } from "@t3tools/shared/localTime";
import type { SubheadRunRow, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSidebar } from "../ui/sidebar";

const DOT: Record<SubheadTone, string> = {
  ok: "bg-muted-foreground/40",
  error: "bg-error",
  warning: "bg-warning",
  info: "bg-info",
  muted: "bg-muted-foreground/40",
};
const TEXT: Record<SubheadTone, string> = {
  ok: "text-success-foreground",
  error: "text-error",
  warning: "text-warning-foreground",
  info: "text-info-foreground",
  muted: "text-sidebar-muted-foreground",
};

/** Where a subhead's page lives; the same link is used by the sidebar and the Harness list. */
export function useOpenSubhead() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return (environmentId: string, name: string) => {
    void navigate({
      to: "/harness/subheads/$environmentId/$name",
      params: { environmentId, name },
    });
    // A phone's drawer closes so the page shows.
    if (isMobile) setOpenMobile(false);
  };
}

/** Sender and thread lookups the rows need from the thread shells the list already holds. */
export interface SubheadThreadLookup {
  readonly title: (environmentId: string, threadId: ThreadId) => string | null;
}

function openRunLabel(run: SubheadRunRow) {
  const first = run.requestSummary.split("\n")[0] ?? "";
  return `${run.status === "queued" ? "Queued" : "Running"}: ${first.length > 40 ? `${first.slice(0, 40)}...` : first}`;
}

function OpenRunRow({
  row,
  run,
  now,
  touch,
  lookup,
  threadExists,
}: {
  readonly row: SubheadRowView;
  readonly run: SubheadRunRow;
  readonly now: number;
  readonly touch: boolean;
  readonly lookup: SubheadThreadLookup;
  readonly threadExists: (environmentId: string, threadId: ThreadId) => boolean;
}) {
  const navigate = useNavigate();
  const openSubhead = useOpenSubhead();
  const { isMobile, setOpenMobile } = useSidebar();
  const sender =
    (run.senderThreadId === null
      ? null
      : lookup.title(row.environmentId, run.senderThreadId)) ?? run.senderPrincipal;
  const queued = run.status === "queued";
  const open = () => {
    // The run thread exists only once the run has started; before that the page shows the wait.
    if (!queued && run.threadId !== null && threadExists(row.environmentId, run.threadId)) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(row.environmentId as never, run.threadId)),
      });
      if (isMobile) setOpenMobile(false);
    } else openSubhead(row.environmentId, row.subhead.name);
  };
  return (
    <li>
      <button
        type="button"
        aria-label={`Open ${run.status} run of ${row.subhead.name}`}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0 rounded-md pr-2.5 pl-7 text-left hover:bg-sidebar-row-hover",
          touch ? "min-h-11 justify-center" : "py-0.5",
        )}
        onClick={open}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", queued ? DOT.warning : DOT.info)}
          />
          <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
            {openRunLabel(run)}
          </span>
          <span className="shrink-0 text-3xs tabular-nums text-sidebar-muted-foreground">
            {formatLocalWhen(Date.parse(run.createdAt), now)}
          </span>
        </span>
        <span className="truncate pl-3 text-3xs text-sidebar-muted-foreground">
          from {sender} · {queued ? `waits for cap ${row.subhead.concurrency}` : "running"}
        </span>
      </button>
    </li>
  );
}

function SubheadRow({
  row,
  now,
  touch,
  selected,
  lookup,
  threadExists,
}: {
  readonly row: SubheadRowView;
  readonly now: number;
  readonly touch: boolean;
  readonly selected: boolean;
  readonly lookup: SubheadThreadLookup;
  readonly threadExists: (environmentId: string, threadId: ThreadId) => boolean;
}) {
  const openSubhead = useOpenSubhead();
  const [collapsed, setCollapsed] = useState(false);
  const hasOpen = row.openRuns.length > 0;
  const tone: SubheadTone = hasOpen
    ? row.running > 0
      ? "info"
      : "warning"
    : row.state === "disabled"
      ? "muted"
      : row.lastTone;
  const right = hasOpen
    ? `${row.openRuns.length} open`
    : row.state === "disabled"
      ? "off"
      : row.lastTone === "error"
        ? "failed"
        : "0 open";
  const rightTone: SubheadTone = hasOpen ? "info" : row.lastTone === "error" ? "error" : "muted";
  const when = row.lastFinished?.finishedAt ?? row.lastFinished?.createdAt ?? null;
  return (
    <li>
      <div
        className={cn(
          "flex items-start rounded-md hover:bg-sidebar-row-hover",
          selected && "bg-sidebar-row-active",
        )}
      >
        <button
          type="button"
          aria-expanded={hasOpen ? !collapsed : undefined}
          aria-label={`${collapsed ? "Show" : "Hide"} open runs of ${row.subhead.name}`}
          disabled={!hasOpen}
          className={cn(
            "flex shrink-0 cursor-pointer items-center justify-center text-sidebar-muted-foreground disabled:cursor-default",
            touch ? "size-11" : "size-7",
          )}
          onClick={() => setCollapsed((value) => !value)}
        >
          {hasOpen ? (
            collapsed ? (
              <ChevronRightIcon aria-hidden className="size-3.5" />
            ) : (
              <ChevronDownIcon aria-hidden className="size-3.5" />
            )
          ) : (
            <span aria-hidden className={cn("size-1.5 rounded-full", DOT[tone])} />
          )}
        </button>
        <button
          type="button"
          aria-label={`Open subhead ${row.subhead.name}`}
          aria-current={selected ? "page" : undefined}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer flex-col gap-0 pr-2.5 text-left",
            touch ? "min-h-11 justify-center" : "py-1",
          )}
          onClick={() => openSubhead(row.environmentId, row.subhead.name)}
        >
          <span className="flex min-w-0 items-center gap-2 text-sm">
            {hasOpen ? (
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
            ) : null}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                row.state === "disabled"
                  ? "text-sidebar-muted-foreground"
                  : "text-sidebar-foreground",
              )}
            >
              {row.subhead.name}
            </span>
            <span className={cn("shrink-0 text-xs", TEXT[rightTone])}>{right}</span>
            {when !== null ? (
              <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
                {formatLocalWhen(Date.parse(when), now)}
              </span>
            ) : null}
          </span>
          <span className="truncate text-3xs text-sidebar-muted-foreground">{row.stateLine}</span>
          {row.lastText !== null && when !== null ? (
            <span className={cn("truncate text-3xs", TEXT[row.lastTone])}>
              {row.lastText} {formatLocalWhen(Date.parse(when), now)}
              {row.lastDetail ? ` · ${row.lastDetail}` : ""}
            </span>
          ) : null}
        </button>
      </div>
      {hasOpen && !collapsed ? (
        <ul className="flex flex-col gap-px">
          {row.openRuns.map((run) => (
            <OpenRunRow
              key={run.runId}
              row={row}
              run={run}
              now={now}
              touch={touch}
              lookup={lookup}
              threadExists={threadExists}
            />
          ))}
          <li>
            <button
              type="button"
              aria-label={`Details and history of ${row.subhead.name}`}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1 rounded-md pl-7 text-left text-3xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                touch ? "min-h-11" : "h-5",
              )}
              onClick={() => openSubhead(row.environmentId, row.subhead.name)}
            >
              Details{row.undelivered > 0 ? ` · ${row.undelivered} undelivered` : ""}
            </button>
          </li>
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The "Subheads" group under one head: a template row per subhead with its open run count and
 * last outcome, and its open runs nested below. Finished history stays on the subhead's page.
 * A head with no subheads never renders this.
 */
export function SubheadGroup({
  group,
  now,
  touch,
  selectedSubhead,
  lookup,
  threadExists,
}: {
  readonly group: SubheadGroupView;
  readonly now: number;
  readonly touch: boolean;
  /** `<environmentId>:<name>` of the subhead open in the main pane. */
  readonly selectedSubhead: string | null;
  readonly lookup: SubheadThreadLookup;
  readonly threadExists: (environmentId: string, threadId: ThreadId) => boolean;
}) {
  const openSubhead = useOpenSubhead();
  const [showRetired, setShowRetired] = useState(false);
  if (group.visible.length === 0 && group.retired.length === 0) return null;
  const summary = summarizeSubheadGroup(group);
  const render = (row: SubheadRowView) => (
    <SubheadRow
      key={row.key}
      row={row}
      now={now}
      touch={touch}
      selected={selectedSubhead === row.key}
      lookup={lookup}
      threadExists={threadExists}
    />
  );
  return (
    <section aria-label="Subheads" className="mb-1 ml-3 flex flex-col">
      {group.visible.length > 0 ? (
        <div className="flex items-baseline gap-2 px-2.5 pt-1 pb-0.5">
          <h3 className="text-3xs font-semibold tracking-wide text-sidebar-muted-foreground uppercase">
            Subheads
          </h3>
          <span className="ml-auto text-3xs text-sidebar-muted-foreground">{summary}</span>
        </div>
      ) : null}
      <ul className="flex flex-col gap-px">{group.visible.map(render)}</ul>
      {group.retired.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={showRetired}
            className={cn(
              "flex w-full cursor-pointer items-center gap-1 px-2.5 text-3xs text-sidebar-muted-foreground hover:text-sidebar-foreground",
              touch ? "min-h-11" : "h-6",
            )}
            onClick={() => setShowRetired((value) => !value)}
          >
            {showRetired ? (
              <ChevronDownIcon aria-hidden className="size-3" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3" />
            )}
            {showRetired ? "Hide" : "Show"} {group.retired.length} retired subhead
            {group.retired.length === 1 ? "" : "s"}
          </button>
          {showRetired ? (
            <ul className="flex flex-col gap-px">
              {group.retired.map((row) => (
                <li key={row.key}>
                  <button
                    type="button"
                    aria-label={`Open retired subhead ${row.subhead.name}`}
                    className={cn(
                      "flex w-full cursor-pointer flex-col rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
                      touch ? "min-h-11 justify-center" : "py-1",
                    )}
                    onClick={() => openSubhead(row.environmentId, row.subhead.name)}
                  >
                    {row.subhead.name}
                    <span className="text-3xs">{row.stateLine}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
