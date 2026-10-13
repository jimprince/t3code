import {
  buildOrchestratorSummaries,
  joinOrchestratorMetadata,
  type OrchestratorSummary,
} from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DashboardTask, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { use, useCallback, useEffect, useMemo, useState } from "react";

import { readProjects, readThreadShells } from "../../state/entities";
import { useDashboardData } from "../../state/dashboard";
import { useSupervisionMetadata } from "../../state/forkSupervision";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Sheet, SheetPopup } from "../ui/sheet";
import { OpenTaskContext } from "../orchestrators/TaskLink";
import { ProjectTaskPanel } from "../orchestrators/ProjectTaskPanel";
import { AskSection, FreshnessStamp, OlderServerLines, VariantSwitcher } from "./chrome";
import { DashboardUiProvider, type DashboardUi, type DecisionRow } from "./context";
import {
  parseIssueTaskId,
  rankDecisions,
  scopeToProject,
  sourceHealth,
  type ScopedProject,
} from "./dashboard.logic";
import { DecisionDialog } from "./decisions";
import { useCollapsedKeys, useDashboardVariant, useMinuteClock } from "./prefs";
import { sectionMarker } from "./parts";
import { useDecisionAnswers } from "./useDecisionAnswers";
import { useVisitBaseline } from "./useVisitBaseline";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";

export type DashboardScope =
  | { readonly kind: "home" }
  | {
      readonly kind: "project";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    };

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
  const metadata = useSupervisionMetadata();
  const [dialogKeys, setDialogKeys] = useState<ReadonlyArray<string>>([]);
  const [sheet, setSheet] = useState<{
    readonly summary: OrchestratorSummary;
    readonly ref: { host: string; repository: string; number: number };
  } | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  // Captured once per instance for the cold-load trace.
  const [mountedAt] = useState(() => performance.now());

  const environmentId = scope.kind === "project" ? scope.environmentId : null;
  const threadId = scope.kind === "project" ? scope.threadId : null;
  const scopeKey = environmentId && threadId ? `${environmentId}:${threadId}` : "home";
  const projectHead = useMemo(
    () => (environmentId && threadId ? { environmentId, threadId } : null),
    [environmentId, threadId],
  );

  const scoped = useMemo(
    () =>
      environmentId && threadId
        ? scopeToProject(state.data, environmentId, threadId)
        : { data: state.data, root: null },
    [environmentId, threadId, state.data],
  );
  const { data, root } = scoped;

  // Summaries are read when a click needs one, not subscribed to: thread shells change constantly
  // while agents run, and the page must not re-render with them.
  const summaryFor = useCallback(
    (target: ScopedProject): OrchestratorSummary | null => {
      const summaries = buildOrchestratorSummaries(
        joinOrchestratorMetadata(readThreadShells(), metadata),
        readProjects(),
      );
      const find = (of: ScopedProject) =>
        summaries.find(
          (summary) =>
            summary.root.environmentId === of.environmentId &&
            summary.root.id === of.project.rootThreadId,
        ) ?? null;
      // A head-only project has no thread of its own; the page's own project answers for it.
      return find(target) ?? (root && root !== target ? find(root) : null);
    },
    [metadata, root],
  );

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
  const reconcileAnswers = answers.reconcile;
  useEffect(() => reconcileAnswers(openKeys), [reconcileAnswers, openKeys]);
  // A project page keeps its own baseline; it must never overwrite Home's. Without the project in
  // the snapshot there is nothing worth storing yet.
  const sinceLooked = useVisitBaseline(scopeKey, data, scope.kind === "home" || root !== null);

  const openTask = useCallback(
    (target: ScopedProject, task: DashboardTask) => {
      const issue = parseIssueTaskId(task.id);
      if (issue && openTaskInPage) return openTaskInPage(issue);
      const summary = issue ? summaryFor(target) : null;
      if (issue && summary) return setSheet({ summary, ref: issue });
      if (task.url) return void window.open(task.url, "_blank", "noopener,noreferrer");
      if (task.threadId)
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(target.environmentId, task.threadId)),
        });
    },
    [navigate, openTaskInPage, summaryFor],
  );

  const stateOf = answers.stateOf;
  const ui = useMemo<DashboardUi>(
    () => ({
      data,
      revision: state.revision,
      now,
      decisions,
      answers,
      decisionKeysFor: (target, task) =>
        task.attentionIds
          .map((id) => `${target.key}|${id}`)
          .filter((key) => openKeys.has(key) && stateOf(key) === null),
      openDecisions: setDialogKeys,
      openTask,
      openProject: (target) => {
        const head = target.project.rootThreadId;
        if (!head || target === root) return;
        void navigate({
          to: "/orchestrators/$environmentId/$threadId",
          params: { environmentId: target.environmentId, threadId: head },
        });
      },
      summaryFor,
      sourceHealth: (sourceId) => {
        const source = data.sources.find((entry) => entry.id === sourceId);
        return source ? sourceHealth(source, now) : null;
      },
      sourceLastSuccessAt: (sourceId) =>
        data.sources.find((entry) => entry.id === sourceId)?.lastSuccessAt ?? null,
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
    }),
    [
      answers,
      collapse.isCollapsed,
      collapse.toggle,
      data,
      decisions,
      navigate,
      now,
      openKeys,
      openTask,
      prefill,
      root,
      sinceLooked,
      state.revision,
      stateOf,
      summaryFor,
    ],
  );

  const ready = data.asOf !== null;
  return (
    <DashboardUiProvider value={ui}>
      <div
        data-testid="dashboard-root"
        data-ready={ready ? "true" : "false"}
        data-revision={state.revision}
        data-mounted-at={mountedAt}
        data-snapshot-source={state.snapshotSource}
        className="flex flex-col gap-2"
      >
        <div {...sectionMarker("freshness", { ready, revision: state.revision })}>
          {/* The switcher leads the row: toasts stack at the top right and must not cover it. */}
          <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
            <VariantSwitcher withPrevious={scope.kind === "project"} />
            {scope.kind === "project" ? (
              <Link to="/dashboard" className="text-xs text-muted-foreground hover:text-foreground">
                Home
              </Link>
            ) : null}
            <FreshnessStamp failed={state.failed} onRetry={state.retry} />
          </div>
          <OlderServerLines names={state.olderEnvironments} />
        </div>
        <AskSection projectHead={projectHead} compact={variant === "B"} />
        {data.asOf === null ? (
          <div data-testid="dashboard-placeholder" className="py-3 text-muted-foreground/80">
            Not loaded yet
          </div>
        ) : scope.kind === "project" && root === null ? (
          <div className="py-3 text-muted-foreground/80">
            Not in this environment&apos;s snapshot
          </div>
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
