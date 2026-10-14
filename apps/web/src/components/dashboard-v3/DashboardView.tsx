import {
  buildOrchestratorSummaries,
  joinOrchestratorMetadata,
  type OrchestratorSummary,
} from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DashboardTask, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { readProjects, readThreadShells } from "../../state/entities";
import { useDashboardData } from "../../state/dashboard";
import { useSupervisionMetadata } from "../../state/forkSupervision";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Sheet, SheetPopup } from "../ui/sheet";
import { OpenTaskContext } from "../orchestrators/TaskLink";
import { ProjectTaskPanel } from "../orchestrators/ProjectTaskPanel";
import { AskSection, FreshnessStamp, OlderServerLines } from "./chrome";
import { DashboardUiProvider, NoticeContext, type DashboardUi, type DecisionRow } from "./context";
import {
  parseIssueTaskId,
  rankDecisions,
  scopeToProject,
  sourceHealth,
  type ScopedProject,
} from "./dashboard.logic";
import { DecisionDialog } from "./decisions";
import { useCollapsedKeys, useMinuteClock } from "./prefs";
import { sectionMarker } from "./parts";
import { useOrderActions, type DashboardNotice, type PendingMoves } from "./orderActions";
import { applyPendingMoves, snapshotHasCaughtUp, type PendingMove } from "./pendingMoves";
import { useDecisionAnswers } from "./useDecisionAnswers";
import { useVisitBaseline } from "./useVisitBaseline";
import { VariantA } from "./VariantA";

const NOTICE_MS = 10 * 60_000;
/** A move shown ahead of the snapshot is dropped after this long even if the snapshot never agrees. */
const PENDING_MOVE_MS = 15_000;

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
export function DashboardView({
  scope,
  leading,
}: {
  readonly scope: DashboardScope;
  /** Rendered above the Ask box and every section (the project's What's next canvas). */
  readonly leading?: ReactNode;
}) {
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
  const [notice, setNotice] = useState<DashboardNotice | null>(null);
  const noticeSeq = useRef(0);
  const report = useCallback((next: Omit<DashboardNotice, "id">) => {
    noticeSeq.current += 1;
    setNotice({ ...next, id: noticeSeq.current });
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);
  // Moves the page shows before the snapshot has them; see pendingMoves.ts.
  const [pendingMoves, setPendingMoves] = useState<
    ReadonlyArray<{ readonly id: number; readonly move: PendingMove; readonly written: boolean }>
  >([]);
  const pendingSeq = useRef(0);
  const pending = useMemo<PendingMoves>(
    () => ({
      add: (move) => {
        pendingSeq.current += 1;
        const id = pendingSeq.current;
        const drop = () => setPendingMoves((current) => current.filter((entry) => entry.id !== id));
        setPendingMoves((current) => [...current, { id, move, written: false }]);
        const timer = setTimeout(drop, PENDING_MOVE_MS);
        return {
          written: () =>
            setPendingMoves((current) =>
              current.map((entry) => (entry.id === id ? { ...entry, written: true } : entry)),
            ),
          drop: () => {
            clearTimeout(timer);
            drop();
          },
        };
      },
    }),
    [],
  );
  const order = useOrderActions(report, pending);
  // A note about a filing or a move folds away after ten minutes; Undo is not offered past that.
  const noticeId = notice?.id;
  useEffect(() => {
    if (noticeId === undefined) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [noticeId]);

  const environmentId = scope.kind === "project" ? scope.environmentId : null;
  const threadId = scope.kind === "project" ? scope.threadId : null;
  const scopeKey = environmentId && threadId ? `${environmentId}:${threadId}` : "home";
  const projectHead = useMemo(
    () => (environmentId && threadId ? { environmentId, threadId } : null),
    [environmentId, threadId],
  );

  const shown = useMemo(
    () =>
      pendingMoves.length === 0
        ? state.data
        : {
            ...state.data,
            projects: applyPendingMoves(
              state.data.projects,
              pendingMoves.map((entry) => entry.move),
            ),
          },
    [state.data, pendingMoves],
  );
  // A project's pending moves end once the server has them and the snapshot shows their order.
  useEffect(() => {
    const caughtUp = new Set<number>();
    for (const key of new Set(pendingMoves.map((entry) => entry.move.projectKey))) {
      const mine = pendingMoves.filter((entry) => entry.move.projectKey === key);
      const project = state.data.projects.find((entry) => entry.key === key)?.project;
      if (
        mine.every((entry) => entry.written) &&
        (!project ||
          snapshotHasCaughtUp(
            project,
            mine.map((entry) => entry.move),
          ))
      )
        for (const entry of mine) caughtUp.add(entry.id);
    }
    if (caughtUp.size > 0)
      setPendingMoves((current) => current.filter((entry) => !caughtUp.has(entry.id)));
  }, [state.data, pendingMoves]);
  const scoped = useMemo(
    () =>
      environmentId && threadId
        ? scopeToProject(shown, environmentId, threadId)
        : { data: shown, root: null },
    [environmentId, threadId, shown],
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
    (target: ScopedProject, task: Pick<DashboardTask, "id" | "url" | "threadId">) => {
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
      order,
      report,
      dismissNotice,
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
      order,
      openTask,
      prefill,
      report,
      dismissNotice,
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
      <NoticeContext value={notice}>
        <div
          data-testid="dashboard-root"
          data-ready={ready ? "true" : "false"}
          data-revision={state.revision}
          data-mounted-at={mountedAt}
          data-snapshot-source={state.snapshotSource}
          className="@container/dash flex flex-col gap-2"
        >
          <div {...sectionMarker("freshness", { ready, revision: state.revision })}>
            <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
              {scope.kind === "project" ? (
                <Link
                  to="/dashboard"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Home
                </Link>
              ) : null}
              <FreshnessStamp failed={state.failed} onRetry={state.retry} />
            </div>
            <OlderServerLines names={state.olderEnvironments} />
          </div>
          {leading}
          <AskSection projectHead={projectHead} />
          {data.asOf === null ? (
            <div data-testid="dashboard-placeholder" className="py-3 text-muted-foreground/80">
              Not loaded yet
            </div>
          ) : scope.kind === "project" && root === null ? (
            <div className="py-3 text-muted-foreground/80">
              Not in this environment&apos;s snapshot
            </div>
          ) : (
            <VariantA />
          )}
        </div>
      </NoticeContext>
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
