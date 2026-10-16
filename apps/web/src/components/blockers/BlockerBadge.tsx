import {
  attentionBlockers,
  blockerHeadline,
  blockerSet,
  type Blocker,
} from "@t3tools/client-runtime/dashboard/blockers";
import { cardSummary } from "@t3tools/client-runtime/decision-card";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  AuthOrchestrationOperateScope,
  type DashboardProject,
  type DashboardSnapshot,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useBlockerSnapshot } from "../../state/dashboard";
import { useServerConfigs } from "../../state/entities";
import { useLiveRuntimeRequests } from "../../state/liveRuntimeRequests";
import { useEnvironmentScope } from "../../state/session";
import type { DecisionRow } from "../dashboard-v3/context";
import { formatClock } from "../dashboard-v3/dashboard.logic";
import { DecisionAnswerArea } from "../dashboard-v3/DecisionAnswerArea";
import { DecisionReceipt, lead } from "../dashboard-v3/decisions";
import { useAnswerPlan, type DecisionAnswers } from "../dashboard-v3/useDecisionAnswers";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useAnswersHost } from "./BlockerAnswers";
import {
  pendingKey,
  useBlockerActions,
  useBlockerPermissions,
  useOpenThread,
  type BlockerActions,
  type ThreadTarget,
} from "./useBlockerActions";

/** Past this many waiting items the popover lists the first few and "and N more" opens the rest. */
const SHOWN_FIRST = 3;

/** A name that is a link wraps inside the popover instead of cutting the words that identify it. */
const LINK_TEXT =
  "min-w-0 break-words [--inline-button-text-align:left] [--inline-button-white-space:normal]";

const KIND_WORD: Record<Blocker["kind"], string> = {
  "waiting-on-brad": "Waiting",
  failed: "Failed",
  "blocked-line": "Blocked",
  stopped: "Stopped",
  "held-queue": "Queue held",
  "blocked-by": "Blocked by",
  "usage-limit": "Usage limit",
  stuck: "Stuck",
  "waiting-question": "Question",
};

const TONE = {
  red: "text-error",
  amber: "text-warning-foreground",
  muted: "text-muted-foreground",
} as const;

/**
 * The badge and its one popover. The trigger keeps the word's colour and gets no chrome; the popup
 * stops pointer and context-menu events so a row's drag handle and menu never see them. While
 * `open` the trigger stays even when nothing is blocked any more, so a receipt never vanishes
 * under the click that made it.
 */
export function BadgeShell({
  tone,
  label,
  ariaLabel,
  className,
  settledLabel,
  active,
  open,
  onOpenChange,
  children,
}: {
  readonly tone: keyof typeof TONE;
  readonly label: ReactNode;
  readonly ariaLabel: string;
  readonly className?: string | undefined;
  /** What the trigger says once nothing is blocked but the popover is still open. */
  readonly settledLabel: string;
  readonly active: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  if (!active && !open) return null;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              "pointer-events-auto shrink-0 cursor-pointer whitespace-nowrap underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring",
              active ? TONE[tone] : "text-muted-foreground",
              className,
            )}
          />
        }
      >
        {active ? label : settledLabel}
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact" align="end">
        <div
          className="flex max-h-[min(70vh,34rem)] w-full flex-col gap-1.5 overflow-y-auto text-xs"
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function Receipts({ actions }: { readonly actions: BlockerActions }) {
  if (actions.receipts.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5" role="status">
      {actions.receipts.map((receipt) => (
        <div
          key={receipt.key}
          className="flex flex-wrap items-center gap-x-2 text-muted-foreground"
        >
          {receipt.failed ? (
            <span className="text-destructive-foreground">!</span>
          ) : (
            <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden />
          )}
          <span>{receipt.text}</span>
          {receipt.undo ? (
            <InlineButton tone="muted" onClick={receipt.undo}>
              Undo
            </InlineButton>
          ) : null}
          {receipt.open ? (
            <InlineButton tone="muted" onClick={receipt.open}>
              Open thread
            </InlineButton>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

/** A usage-limit reason carries the reset as an ISO time; the reader gets their local clock. */
const localizedReason = (blocker: Blocker, now: number) =>
  blocker.kind === "usage-limit" && blocker.reason
    ? blocker.reason.replace(ISO_TIME, (iso) => formatClock(iso, now))
    : blocker.reason;

/** One red blocker: what blocks (a link), why, and its own button when it has one. */
function BlockerItem({
  blocker,
  rowEnvironmentId,
  scopeRootId,
  actions,
  now,
}: {
  readonly blocker: Blocker;
  readonly rowEnvironmentId: EnvironmentId;
  readonly scopeRootId: ThreadId | null;
  readonly actions: BlockerActions;
  readonly now: number;
}) {
  const { action } = blocker;
  const environmentId = blocker.target.environmentId ?? rowEnvironmentId;
  const threadId = blocker.target.threadId;
  const issueUrl = blocker.target.issueUrl;
  const resumeTarget: ThreadTarget | null =
    action?.type === "resume-plan" || action?.type === "resume-queue"
      ? { environmentId, threadId: action.threadId }
      : null;
  const resume =
    resumeTarget && action?.type === "resume-plan"
      ? { label: "Resume from plan", run: () => actions.resumeFromPlan(resumeTarget) }
      : resumeTarget && action?.type === "resume-queue"
        ? { label: "Resume queue", run: () => actions.resumeThreadQueue(resumeTarget) }
        : null;
  const pending =
    resume && resumeTarget
      ? actions.pending.has(
          pendingKey(action?.type === "resume-queue" ? "queue" : "plan", resumeTarget),
        )
      : false;
  const reason = localizedReason(blocker, now);
  return (
    <div className="flex flex-col gap-0.5 py-1" data-testid="blocker-item">
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-error">{KIND_WORD[blocker.kind]}:</span>
        {threadId ? (
          <span className={LINK_TEXT}>
            <InlineButton onClick={() => actions.openThread(environmentId, threadId)}>
              {blocker.name}
            </InlineButton>
          </span>
        ) : issueUrl ? (
          <span className={LINK_TEXT}>
            <InlineButton onClick={() => window.open(issueUrl, "_blank", "noopener,noreferrer")}>
              {blocker.name}
            </InlineButton>
          </span>
        ) : (
          <span className={`${LINK_TEXT} font-medium`}>{blocker.name}</span>
        )}
        {blocker.owner &&
        blocker.owner.threadId !== scopeRootId &&
        blocker.owner.threadId !== threadId ? (
          <span className="shrink-0 text-muted-foreground">in {blocker.owner.name}</span>
        ) : null}
      </div>
      {reason ? (
        <div className="line-clamp-2 break-words text-muted-foreground">{reason}</div>
      ) : null}
      {resume ? (
        <div>
          <Button size="xs" variant="outline" disabled={pending} onClick={resume.run}>
            {pending
              ? action?.type === "resume-queue"
                ? "Resuming queue"
                : "Resuming"
              : resume.label}
          </Button>
        </div>
      ) : action === null && blocker.actionReason ? (
        <div className="text-muted-foreground/80 italic">{blocker.actionReason}</div>
      ) : null}
    </div>
  );
}

/**
 * A blocker on another environment is derived with the row's permissions; its action runs there, so
 * it needs that server's capability. The operate scope is the server's to refuse, with a typed reason.
 */
function useRemoteGate(rowEnvironmentId: EnvironmentId) {
  const configs = useServerConfigs();
  return (blocker: Blocker): Blocker => {
    const environmentId = blocker.target.environmentId ?? rowEnvironmentId;
    const { action } = blocker;
    if (environmentId === rowEnvironmentId || action === null) return blocker;
    const capabilities = configs.get(environmentId)?.environment.capabilities;
    const supported =
      action.type === "settle"
        ? capabilities?.threadSettlement === true
        : action.type === "resume-plan"
          ? capabilities?.threadResumeFromPlan === true
          : true;
    return supported
      ? blocker
      : { ...blocker, action: null, actionReason: "This server does not support this action." };
  };
}

/**
 * The red popover body: every blocker by name with its reason and its own button when it has one.
 * Nothing is folded away, so the one "Settle N" acts on exactly the N entries listed below it (the
 * popup scrolls when the list is long). Heads and BLOCKED-only workers carry no Settle. The
 * receipts and their Undo live in this popup, so they end when it closes.
 */
export function BlockerList({
  blockers: derived,
  rowEnvironmentId,
  scopeRootId,
  emptyText = "No thread is blocked",
  children,
}: {
  readonly blockers: ReadonlyArray<Blocker>;
  readonly rowEnvironmentId: EnvironmentId;
  readonly scopeRootId: ThreadId | null;
  readonly emptyText?: string;
  /** Extra links under the list (a task's "Open task"). */
  readonly children?: ReactNode;
}) {
  const actions = useBlockerActions();
  const gate = useRemoteGate(rowEnvironmentId);
  const blockers = derived.map(gate);
  const [now] = useState(() => Date.now());
  const settleTargets: ThreadTarget[] = blockers.flatMap((blocker) =>
    blocker.action?.type === "settle"
      ? blocker.action.threadIds.map((threadId) => ({
          environmentId: blocker.target.environmentId ?? rowEnvironmentId,
          threadId,
        }))
      : [],
  );
  const settling = actions.pending.has("settle");
  return (
    <>
      <div className="font-medium">
        {blockers.length === 0 ? emptyText : blockerHeadline(blockers)}
      </div>
      {settleTargets.length > 0 ? (
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={settling}
            onClick={() => void actions.settleThreads(settleTargets)}
          >
            {settling ? "Settling" : `Settle ${settleTargets.length}`}
          </Button>
        </div>
      ) : null}
      <Receipts actions={actions} />
      {blockers.map((blocker) => (
        <BlockerItem
          key={blocker.key}
          blocker={blocker}
          rowEnvironmentId={rowEnvironmentId}
          scopeRootId={scopeRootId}
          actions={actions}
          now={now}
        />
      ))}
      {children}
    </>
  );
}

/** The popup body of a row's badge: the page's own list, else the summary's exact blocker set. */
function RowBlockers({
  summary,
  blockers,
}: {
  readonly summary: OrchestratorSummary;
  readonly blockers: ReadonlyArray<Blocker> | undefined;
}) {
  const environmentId = summary.root.environmentId;
  const permissions = useBlockerPermissions(environmentId);
  const [now] = useState(() => new Date().toISOString());
  const derived = useMemo(
    () => blockers ?? blockerSet(summary, { ...permissions, now }),
    [blockers, summary, permissions, now],
  );
  return (
    <BlockerList
      blockers={derived}
      rowEnvironmentId={environmentId}
      scopeRootId={summary.root.id}
    />
  );
}

/**
 * The red "Blocked" on a row: opens the failed, stopped or held threads under it by name, with the
 * one action that clears each. The badge's count and its list are one set (`blockerSet`, or the
 * page's `blockers` when it adds task causes), so they cannot disagree.
 */
export function BlockedBadge({
  summary,
  blockers,
  active,
  label = "Blocked",
  className,
}: {
  readonly summary: OrchestratorSummary;
  /** The page's own list (`projectBlockerSet`), when its count must include task causes. */
  readonly blockers?: ReadonlyArray<Blocker> | undefined;
  readonly active: boolean;
  readonly label?: string;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <BadgeShell
      tone="red"
      open={open}
      onOpenChange={setOpen}
      label={label}
      ariaLabel={`${label}: what is blocked and how to clear it`}
      className={className}
      settledLabel="Cleared"
      active={active}
    >
      <RowBlockers summary={summary} blockers={blockers} />
    </BadgeShell>
  );
}

/** Opens what a waiting item is about: its issue in a new tab, else the thread that asks. */
function useOpenDecisionRow() {
  const openThread = useOpenThread();
  return (row: DecisionRow) => {
    const { attention, scoped } = row;
    if (attention.url) window.open(attention.url, "_blank", "noopener,noreferrer");
    else if (attention.threadId) openThread(scoped.environmentId, attention.threadId);
  };
}

/** The blocker a Dashboard decision row stands for, for a list that already holds its rows. */
export function blockerOfRow(row: DecisionRow): Blocker {
  const { attention } = row;
  return {
    key: attention.id,
    kind: "waiting-on-brad",
    name: attention.title,
    reason: lead(cardSummary(attention) ?? "") || null,
    target: {
      ...(attention.threadId ? { threadId: attention.threadId } : {}),
      ...(attention.url ? { issueUrl: attention.url } : {}),
      attentionId: attention.id,
    },
    action: attention.canRespond ? { type: "answer", attentionId: attention.id } : null,
    actionReason: attention.canRespond
      ? null
      : "Open the item to respond; inline answers are unavailable.",
    owner: row.scoped.project.rootThreadId
      ? { threadId: row.scoped.project.rootThreadId, name: row.scoped.project.title }
      : null,
    attention,
  };
}

/**
 * Rebuilds the Decisions row an attention belongs to, keyed as the Dashboard keys it. A live ask
 * the stored copy never had (navigation-only) belongs to the project its owner heads.
 */
function rowFor(
  snapshot: Pick<DashboardSnapshot, "projects">,
  environmentId: EnvironmentId,
  blocker: Blocker,
): DecisionRow | null {
  const attention = blocker.attention;
  const project =
    snapshot.projects.find((candidate) =>
      candidate.attention.some((entry) => entry.id === blocker.key),
    ) ?? snapshot.projects.find((candidate) => candidate.rootThreadId === blocker.owner?.threadId);
  if (!attention || !project) return null;
  const key = `${environmentId}:${project.id}`;
  return { key: `${key}|${attention.id}`, scoped: { key, environmentId, project }, attention };
}

function WaitingItem({
  row,
  blocker,
  scopeRootId,
  answers,
  onOpen,
}: {
  readonly row: DecisionRow;
  readonly blocker: Blocker;
  /** The row the popover decorates; an item from a project beneath it names that project. */
  readonly scopeRootId: ThreadId | null;
  readonly answers: DecisionAnswers | null;
  readonly onOpen: () => void;
}) {
  const plan = useAnswerPlan(row);
  const state = answers?.stateOf(row.key) ?? null;
  if (answers && state) return <DecisionReceipt row={row} state={state} answers={answers} />;
  const { attention } = row;
  const summary = cardSummary(attention);
  const answerable = answers !== null && blocker.action?.type === "answer";
  const links =
    answerable && (plan.mode === "questions" || plan.mode === "approval") ? null : (
      <InlineButton tone="muted" onClick={onOpen}>
        Open
      </InlineButton>
    );
  return (
    <div className="flex flex-col gap-0.5 py-1" data-testid="blocker-item">
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-warning-foreground">{attention.kind}:</span>
        <span className={LINK_TEXT}>
          <InlineButton onClick={onOpen}>{attention.title}</InlineButton>
        </span>
        {blocker.owner && scopeRootId && blocker.owner.threadId !== scopeRootId ? (
          <span className="shrink-0 text-muted-foreground">in {blocker.owner.name}</span>
        ) : null}
      </div>
      {summary ? (
        <div className="line-clamp-2 break-words text-muted-foreground">{lead(summary)}</div>
      ) : null}
      {answerable ? (
        <DecisionAnswerArea row={row} plan={plan} answers={answers} compact>
          {links}
        </DecisionAnswerArea>
      ) : (
        <>
          {blocker.actionReason ? (
            <div className="text-muted-foreground/80 italic">{blocker.actionReason}</div>
          ) : null}
          {links ? <div>{links}</div> : null}
        </>
      )}
    </div>
  );
}

/**
 * The amber popover: each item waiting on Brad, the first few open with the same answer area the
 * Decisions card has. An answered item keeps its receipt (Undo while held) until the popover
 * closes, even after the snapshot drops it.
 */
export function WaitingList({
  entries,
  headline,
  asOf,
  stored,
  openItem,
  scopeRootId = null,
}: {
  readonly entries: ReadonlyArray<{ readonly row: DecisionRow; readonly blocker: Blocker }>;
  readonly headline: string;
  readonly asOf: string | null;
  /** True when the list comes from the copy stored on this device. */
  readonly stored: boolean;
  readonly openItem: (row: DecisionRow) => void;
  readonly scopeRootId?: ThreadId | null;
}) {
  const host = useAnswersHost();
  const answers = host?.answers ?? null;
  const [expanded, setExpanded] = useState(false);
  // Entries seen while open, so an answered one can show its receipt after the snapshot drops it.
  const [seen, setSeen] = useState<ReadonlyMap<string, DecisionRow>>(new Map());
  if (entries.some(({ row }) => !seen.has(row.key)))
    setSeen(new Map([...seen, ...entries.map(({ row }) => [row.key, row] as const)]));
  const live = new Set(entries.map(({ row }) => row.key));
  const gone = [...seen.values()].filter((row) => !live.has(row.key) && answers?.stateOf(row.key));
  const [renderedAt] = useState(() => Date.now());
  const shown = expanded ? entries : entries.slice(0, SHOWN_FIRST);
  return (
    <>
      <div className="font-medium">
        {headline}
        {stored && asOf ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            · as of {formatClock(asOf, renderedAt)}
          </span>
        ) : null}
      </div>
      {shown.map(({ row, blocker }) => (
        <WaitingItem
          key={row.key}
          row={row}
          blocker={blocker}
          scopeRootId={scopeRootId}
          answers={answers}
          onOpen={() => openItem(row)}
        />
      ))}
      {!expanded && entries.length > SHOWN_FIRST ? (
        <div>
          <InlineButton tone="muted" onClick={() => setExpanded(true)}>
            and {entries.length - SHOWN_FIRST} more
          </InlineButton>
        </div>
      ) : null}
      {gone.map((row) =>
        answers ? (
          <DecisionReceipt
            key={row.key}
            row={row}
            state={answers.stateOf(row.key)!}
            answers={answers}
          />
        ) : null,
      )}
    </>
  );
}

/** Every thread a row stands for, subprojects included, so a live ask finds its project. */
function rowShells(summary: OrchestratorSummary): OrchestratorSummary["descendants"] {
  return [summary.root, ...summary.descendants, ...summary.subprojects.flatMap(rowShells)];
}

/** The project a row's root heads, for a row the snapshot does not have (yet). */
function minimalProject(summary: OrchestratorSummary, parentId: string | null): DashboardProject {
  return {
    id: `thread:${summary.root.id}`,
    rootThreadId: summary.root.id,
    parentId,
    title: summary.root.title,
    utility: false,
    omittedTaskCount: 0,
    workstreams: [],
    tasks: [],
    attention: [],
    sourceIds: [],
  };
}

/**
 * The snapshot with a project added for every row of `summary` it lacks, so a live ask in a
 * thread the snapshot never heard of is still listed with its row rather than shown as a bare count.
 */
function withRowProjects(
  snapshot: Pick<DashboardSnapshot, "projects" | "asOf"> | null,
  summary: OrchestratorSummary,
): Pick<DashboardSnapshot, "projects" | "asOf"> {
  const projects = [...(snapshot?.projects ?? [])];
  const add = (row: OrchestratorSummary, parentId: string | null) => {
    const existing = projects.find((project) => project.rootThreadId === row.root.id);
    const id = existing ? existing.id : minimalProject(row, parentId).id;
    if (!existing) projects.push(minimalProject(row, parentId));
    for (const sub of row.subprojects) add(sub, id);
  };
  add(summary, null);
  return { projects, asOf: snapshot?.asOf ?? new Date(0).toISOString() };
}

/**
 * The amber "Waiting on Brad" for a row of the sidebar or a project list: the tracker items and
 * thread asks under the row, from the Dashboard snapshot a mounted Dashboard holds, else the copy
 * stored on this device (labelled "as of" in the popover), unioned with the asks the live thread
 * shells carry now. The count and the list read the same entries, so they always agree; with
 * nothing listed it falls back to the thread-level count the shells carry, plain and without a list.
 */
export function WaitingBadge({
  summary,
  fallbackCount,
  openItem,
  className,
  compactLabel = false,
}: {
  readonly summary: OrchestratorSummary;
  /** The thread-level asks the shells count, used when no item can be listed. */
  readonly fallbackCount: number;
  /** Where a click on an item's name goes; the default opens its issue or thread. */
  readonly openItem?: (row: DecisionRow) => void;
  readonly className?: string;
  /** Shortens "Waiting on Brad 12" to "12" below the row's container width. */
  readonly compactLabel?: boolean;
}) {
  const environmentId = summary.root.environmentId;
  const rootId = summary.root.id;
  const openDefault = useOpenDecisionRow();
  const { snapshot, stored } = useBlockerSnapshot(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const live = useLiveRuntimeRequests();
  const view = useMemo(() => {
    const scoped = withRowProjects(snapshot, summary);
    const result = attentionBlockers(scoped, rootId, {
      stored,
      canOperate,
      live,
      shells: rowShells(summary),
      environmentId,
    });
    const entries = result.blockers.flatMap((blocker) => {
      const row = rowFor(scoped, environmentId, blocker);
      return row ? [{ row, blocker }] : [];
    });
    return {
      entries,
      headline: blockerHeadline(entries.map(({ blocker }) => blocker)),
      asOf: snapshot ? result.asOf : null,
    };
  }, [snapshot, stored, canOperate, live, environmentId, rootId, summary]);
  const count = view.entries.length;
  const host = useAnswersHost();
  const report = host?.report;
  const owner = `${environmentId}:${rootId}`;
  const liveKeys = view.entries.map(({ row }) => row.key).join("\n");
  // The keys this row lists, so a delivered answer stays answered while the snapshot still lags.
  useEffect(() => {
    report?.(owner, new Set(liveKeys ? liveKeys.split("\n") : []));
    return () => report?.(owner, null);
  }, [report, owner, liveKeys]);
  const [open, setOpen] = useState(false);
  const [renderedAt] = useState(() => Date.now());
  if (count === 0 && !open)
    return fallbackCount > 0 ? (
      <span className={cn("shrink-0 tabular-nums text-warning-foreground", className)}>
        {fallbackCount}
      </span>
    ) : null;
  // A device-stored copy can be a day old: its count reads muted with its age in the label, unless a
  // live ask (which the shells vouch for now) is among the items.
  const stale =
    stored && view.asOf !== null && !view.entries.some(({ row }) => row.attention.requestId);
  return (
    <BadgeShell
      tone={stale ? "muted" : "amber"}
      label={
        <>
          <span className={compactLabel ? "hidden @min-[22rem]/row:inline" : undefined}>
            Waiting on Brad{" "}
          </span>
          <span className="tabular-nums">{count}</span>
        </>
      }
      ariaLabel={`Waiting on Brad, ${count}${stale && view.asOf ? `, as of ${formatClock(view.asOf, renderedAt)}` : ""}: the list and its answers`}
      className={className}
      settledLabel="Answered"
      active={count > 0}
      open={open}
      onOpenChange={setOpen}
    >
      <WaitingList
        entries={view.entries}
        headline={count > 0 ? view.headline : "Waiting on Brad: nothing"}
        asOf={view.asOf}
        stored={stored}
        openItem={openItem ?? openDefault}
        scopeRootId={rootId}
      />
    </BadgeShell>
  );
}
