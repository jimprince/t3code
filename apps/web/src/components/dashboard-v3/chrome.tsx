import { buildOrchestratorSummaries } from "@t3tools/client-runtime/state/orchestrators";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { InlineButton } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectRequestBox, REQUEST_QUICK_ACTIONS } from "../orchestrators/ProjectRequestBox";
import { useOrchestratorThreadShells } from "../orchestrators/useOrchestratorThreads";
import { useDashboardUi } from "./context";
import {
  formatClock,
  freshnessSummary,
  sourceHealth,
  sourceLabel,
  type SourceHealth,
  type SourceNames,
} from "./dashboard.logic";
import {
  DASHBOARD_VARIANTS,
  VARIANT_TITLE,
  useDashboardVariant,
  type DashboardVariant,
} from "./prefs";
import { UnknownValue, useSectionMarker } from "./parts";

const COS_TITLE = /chief of staff/i;

const HEALTH_WORD: Record<SourceHealth, string> = {
  fresh: "fresh",
  stale: "stale",
  failed: "slow, last good shown",
  partial: "partial coverage",
};
// Late is routine, so it is never red; a source that has never returned anything is the exception.
const HEALTH_CLASS: Record<SourceHealth, string> = {
  fresh: "text-success",
  stale: "text-muted-foreground",
  failed: "text-muted-foreground",
  partial: "text-muted-foreground",
};

/** Server labels and project titles, so a source reads as words and not as an id. */
function useSourceNames(): SourceNames {
  const { data } = useDashboardUi();
  const { environments } = useEnvironments();
  return useMemo(
    () => ({
      environments: new Map(
        environments.map((environment) => [environment.environmentId as string, environment.label]),
      ),
      projectTitle: (rootThreadId) =>
        data.projects.find((entry) => entry.project.rootThreadId === rootThreadId)?.project.title,
    }),
    [data.projects, environments],
  );
}

/**
 * "as of 7:42 am" in local time, with an amber suffix naming a stale source and a red one when a
 * refresh failed. Opens the sources table so each fact keeps the age of its own source.
 */
export function FreshnessStamp({
  failed,
  onRetry,
}: {
  readonly failed: boolean;
  /** Offered beside "refresh failed"; absent when the data layer has no way to retry. */
  readonly onRetry?: (() => void) | undefined;
}) {
  const { data, now } = useDashboardUi();
  const [open, setOpen] = useState(false);
  const names = useSourceNames();
  if (data.asOf === null) return null;
  const suffix = freshnessSummary(data.sources, now, names);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        as of {formatClock(data.asOf, now)}
        {suffix ? (
          <span className={suffix.failed ? "text-destructive-foreground" : undefined}>
            · {suffix.text}
          </span>
        ) : null}
        {failed ? <span>· refresh failed</span> : null}
      </button>
      {failed && onRetry ? (
        <InlineButton tone="muted" onClick={onRetry}>
          Retry
        </InlineButton>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Snapshot as of {formatClock(data.asOf, now)}</DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-5">
            {data.sources.length === 0 ? (
              <UnknownValue>no sources reported</UnknownValue>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {data.sources.map((source) => {
                    const health = sourceHealth(source, now);
                    return (
                      <tr key={source.id} className="border-b border-border last:border-0">
                        <td className="py-1 pr-3">{sourceLabel(source, names)}</td>
                        <td className="py-1 pr-3 text-muted-foreground tabular-nums">
                          {source.lastSuccessAt ? formatClock(source.lastSuccessAt, now) : "never"}
                        </td>
                        <td
                          className={`py-1 ${
                            health === "failed" && !source.lastSuccessAt
                              ? "text-destructive-foreground"
                              : HEALTH_CLASS[health]
                          }`}
                        >
                          {HEALTH_WORD[health]}
                          {health === "stale" && source.lastSuccessAt
                            ? ` since ${formatClock(
                                new Date(
                                  Date.parse(source.lastSuccessAt) + source.staleAfterMs,
                                ).toISOString(),
                                now,
                              )}`
                            : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** One muted line per connected server that predates the Dashboard snapshot. */
export function OlderServerLines({ names }: { readonly names: ReadonlyArray<string> }) {
  return names.map((name) => (
    <div key={name} className="text-xs text-muted-foreground">
      {name} runs an older server
    </div>
  ));
}

/**
 * A three-segment control (plus the previous dashboard on project pages, the only place it exists)
 * for the review: it is removed with the losing variants once Brad picks. One preference for Home
 * and every project page.
 */
export function VariantSwitcher({ withPrevious = true }: { readonly withPrevious?: boolean }) {
  const [stored, setVariant] = useDashboardVariant();
  // Home has no previous dashboard, so a stored "previous" reads as A there, as the page renders it.
  const variant = !withPrevious && stored === "previous" ? "A" : stored;
  return (
    <ToggleGroup
      aria-label="Dashboard design"
      value={[variant]}
      onValueChange={(next) => {
        const value = next[0];
        if (DASHBOARD_VARIANTS.includes(value as DashboardVariant))
          setVariant(value as DashboardVariant);
      }}
    >
      {DASHBOARD_VARIANTS.filter((value) => withPrevious || value !== "previous").map((value) => (
        <Tooltip key={value}>
          <TooltipTrigger
            render={<Toggle value={value}>{value === "previous" ? "Previous" : value}</Toggle>}
          />
          <TooltipPopup>{VARIANT_TITLE[value]}</TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

/**
 * Ask first (R11): the existing request box, routed to the Chief of Staff on Home and to the page's
 * own project head on a project page. It reads the thread shells itself so a shell change
 * re-renders only this box, not the whole Dashboard.
 */
export function AskSection({
  projectHead,
  compact = false,
}: {
  /** The project page's head thread; null on Home. */
  readonly projectHead: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } | null;
  readonly compact?: boolean;
}) {
  const ui = useDashboardUi();
  const marker = useSectionMarker("ask");
  const projects = useProjects();
  const threads = useOrchestratorThreadShells();
  const summary = useMemo(() => {
    const summaries = buildOrchestratorSummaries(threads, projects);
    return projectHead
      ? (summaries.find(
          (entry) =>
            entry.root.environmentId === projectHead.environmentId &&
            entry.root.id === projectHead.threadId,
        ) ?? null)
      : (summaries.find((entry) => COS_TITLE.test(entry.root.title)) ?? null);
  }, [projectHead, projects, threads]);
  if (!summary) return <div {...marker} hidden />;
  return (
    <div {...marker}>
      <ProjectRequestBox
        summary={summary}
        quickActions={compact ? undefined : REQUEST_QUICK_ACTIONS}
        prefill={ui.prefill}
        placeholder={`New request to ${summary.root.title}`}
      />
    </div>
  );
}
