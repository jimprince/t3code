import {
  buildOrchestratorSummaries,
  type OrchestratorSummary,
} from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DashboardTask, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { use, useMemo, useState } from "react";

import { useProjects } from "../../state/entities";
import { useDashboardData } from "../../state/dashboard";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Sheet, SheetPopup } from "../ui/sheet";
import { OpenTaskContext } from "../orchestrators/TaskLink";
import { ProjectTaskPanel } from "../orchestrators/ProjectTaskPanel";
import { useOrchestratorThreadShells } from "../orchestrators/useOrchestratorThreads";
import { AskBar, FreshnessStamp, VariantSwitcher } from "./chrome";
import { DashboardUiProvider, type DashboardUi, type DecisionRow } from "./context";
import { rankDecisions, scopeToProject, sourceHealth, type ScopedProject } from "./dashboard.logic";
import { DecisionDialog } from "./decisions";
import { useCollapsedKeys, useDashboardVariant, useMinuteClock } from "./prefs";
import { useDecisionAnswers } from "./useDecisionAnswers";
import { useVisitBaseline } from "./useVisitBaseline";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";
import { parseIssueTaskId } from "./dashboard.logic";

export type DashboardScope =
  | { readonly kind: "home" }
  | {
      readonly kind: "project";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    };

const COS_TITLE = /chief of staff/i;

/**
 * The Dashboard: Home across every connected environment, or one project page, both built from the
 * same rows. It renders the last good snapshot at once and swaps a newer revision in whole; there
 * are no loading states, only "Not loaded yet" before the very first snapshot ever arrives.
 */
export function DashboardView({ scope }: { readonly scope: DashboardScope }) {
  const [storedVariant] = useDashboardVariant();
  // Home has no previous dashboard to fall back on.
  const variant = storedVariant === "previous" ? "A" : storedVariant;
  const state = useDashboardData();
  const now = useMinuteClock();
  const navigate = useNavigate();
  const openTaskInPage = use(OpenTaskContext);
  const collapse = useCollapsedKeys();
  const answers = useDecisionAnswers();
  const [dialogKeys, setDialogKeys] = useState<ReadonlyArray<string>>([]);
  const [sheet, setSheet] = useState<{
    readonly summary: OrchestratorSummary;
    readonly ref: { host: string; repository: string; number: number };
  } | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);

  const projects = useProjects();
  const threads = useOrchestratorThreadShells();
  const summaries = useMemo(
    () => buildOrchestratorSummaries(threads, projects),
    [projects, threads],
  );

  const scoped = useMemo(
    () =>
      scope.kind === "home"
        ? { data: state.data, root: null }
        : scopeToProject(state.data, scope.environmentId, scope.threadId),
    [scope, state.data],
  );
  const { data, root } = scoped;

  const summaryFor = (target: ScopedProject): OrchestratorSummary | null => {
    const exact = summaries.find(
      (summary) =>
        summary.root.environmentId === target.environmentId &&
        summary.root.id === target.project.rootThreadId,
    );
    if (exact) return exact;
    // A head-only project has no thread of its own; the page's own project answers for it.
    return root && root !== target ? summaryFor(root) : null;
  };

  const decisions = useMemo<ReadonlyArray<DecisionRow>>(() => {
    const rows = data.projects.flatMap((entry) =>
      entry.project.attention.map((attention) => ({
        key: `${entry.key}|${attention.id}`,
        scoped: entry,
        attention,
      })),
    );
    const ranked = rankDecisions(rows.map((row) => row.attention));
    return ranked.flatMap((attention) => {
      const index = rows.findIndex((row) => row.attention === attention);
      return index >= 0 ? [rows[index]!] : [];
    });
  }, [data.projects]);

  const openKeys = useMemo(() => new Set(decisions.map((row) => row.key)), [decisions]);
  const sinceLooked = useVisitBaseline(root ? root.key : "home", data);

  const openTask = (target: ScopedProject, task: DashboardTask) => {
    const issue = parseIssueTaskId(task.id);
    const summary = summaryFor(target);
    if (issue && openTaskInPage) return openTaskInPage(issue);
    if (issue && summary) return setSheet({ summary, ref: issue });
    if (task.url) return void window.open(task.url, "_blank", "noopener,noreferrer");
    if (task.threadId)
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(target.environmentId, task.threadId)),
      });
  };

  const ui: DashboardUi = {
    data,
    now,
    decisions,
    answers,
    decisionKeysFor: (target, task) =>
      task.attentionIds
        .map((id) => `${target.key}|${id}`)
        .filter((key) => openKeys.has(key) && answers.stateOf(key) === null),
    openDecisions: setDialogKeys,
    openTask,
    openProject: (target) => {
      const threadId = target.project.rootThreadId;
      if (!threadId || target === root) return;
      void navigate({
        to: "/orchestrators/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId },
      });
    },
    summaryFor,
    sourceHealth: (sourceId) => {
      const source = data.sources.find((entry) => entry.id === sourceId);
      return source ? sourceHealth(source, now) : null;
    },
    isCollapsed: collapse.isCollapsed,
    toggleCollapsed: collapse.toggle,
    sinceLooked,
    root,
    prefill,
    unstick: (title) =>
      setPrefill((current) => ({
        text: `${title} has had no steps in the last hour. Check it and restart or reassign.`,
        nonce: (current?.nonce ?? 0) + 1,
      })),
  };

  const askSummary = root
    ? summaryFor(root)
    : (summaries.find((summary) => COS_TITLE.test(summary.root.title)) ?? null);
  const askRoute = root ? root.project.title : (askSummary?.root.title ?? "Chief of Staff");

  return (
    <DashboardUiProvider value={ui}>
      <div className="flex flex-col gap-2">
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
          <FreshnessStamp failed={state.failed} />
          <span className="flex-1" />
          <span className="text-xs text-muted-foreground">Last hour</span>
          <VariantSwitcher />
        </div>
        <AskBar summary={askSummary} routeLabel={askRoute} compact={variant === "B"} />
        {data.asOf === null ? (
          <div className="py-3 text-muted-foreground/80">Not loaded yet</div>
        ) : variant === "B" ? (
          <VariantB />
        ) : variant === "C" ? (
          <VariantC />
        ) : (
          <VariantA />
        )}
      </div>
      <DecisionDialog keys={dialogKeys} onClose={() => setDialogKeys([])} />
      <Sheet open={sheet !== null} onOpenChange={(open) => (open ? undefined : setSheet(null))}>
        <SheetPopup showCloseButton={false}>
          {sheet ? (
            <ProjectTaskPanel
              summary={sheet.summary}
              task={sheet.ref}
              onClose={() => setSheet(null)}
            />
          ) : null}
        </SheetPopup>
      </Sheet>
    </DashboardUiProvider>
  );
}
