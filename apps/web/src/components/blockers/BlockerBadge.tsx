import {
  attentionBlockers,
  blockerHeadline,
  threadBlockers,
  type Blocker,
} from "@t3tools/client-runtime/dashboard/blockers";
import { cardSummary } from "@t3tools/client-runtime/decision-card";
import { liveAttention } from "@t3tools/client-runtime/dashboard/live";
import {
  AuthOrchestrationOperateScope,
  type DashboardSnapshot,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import { useBlockerSnapshot } from "../../state/dashboard";
import { useLiveRuntimeRequests } from "../../state/liveRuntimeRequests";
import { useEnvironmentScope } from "../../state/session";
import { DashboardUiProvider, type DecisionRow } from "../dashboard-v3/context";
import { formatClock } from "../dashboard-v3/dashboard.logic";
import { DecisionAnswerArea } from "../dashboard-v3/DecisionAnswerArea";
import { DecisionReceipt, lead } from "../dashboard-v3/decisions";
import {
  useAnswerPlan,
  useDecisionAnswers,
  type DecisionAnswers,
} from "../dashboard-v3/useDecisionAnswers";
import { useOrchestratorThreadShells } from "../orchestrators/useOrchestratorThreads";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  useBlockerActions,
  useBlockerPermissions,
  useOpenThread,
  type BlockerActions,
} from "./useBlockerActions";

/** Past this many entries the popover lists the first few and "and N more" opens the rest in place. */
const SHOWN_FIRST = 3;

/** A name that is a link wraps inside the popover instead of cutting the words that identify it. */
const LINK_TEXT =
  "min-w-0 break-words [--inline-button-text-align:left] [--inline-button-white-space:normal]";

const KIND_WORD: Record<Blocker["kind"], string> = {
  "waiting-on-brad": "Waiting",
  failed: "Failed",
  "blocked-line": "Blocked reply",
  stopped: "Stopped",
  "held-queue": "Queue held",
  "blocked-by": "Blocked by",
  "usage-limit": "Usage limit",
};

interface BlockerAnswersHost {
  readonly answers: DecisionAnswers;
  /** A badge reports the decisions it lists, so a delivered answer stays answered while it lags. */
  readonly report: (owner: string, keys: ReadonlySet<string> | null) => void;
}

const BlockerAnswersContext = createContext<BlockerAnswersHost | null>(null);

/**
 * One answers hook for every badge under it (the sidebar list, a project page), so an answer's
 * Undo hold survives its popover closing and the badges agree on which decisions are still open.
 */
export function BlockerAnswersProvider({ children }: { readonly children: ReactNode }) {
  const answers = useDecisionAnswers();
  const reported = useRef(new Map<string, ReadonlySet<string>>());
  const reconcile = answers.reconcile;
  const report = useCallback(
    (owner: string, keys: ReadonlySet<string> | null) => {
      if (keys) reported.current.set(owner, keys);
      else reported.current.delete(owner);
      reconcile(new Set([...reported.current.values()].flatMap((entry) => [...entry])));
    },
    [reconcile],
  );
  const host = useMemo(() => ({ answers, report }), [answers, report]);
  return <BlockerAnswersContext value={host}>{children}</BlockerAnswersContext>;
}

/** The provider's answers, else the Dashboard's own when this badge sits inside one. */
function useAnswersHost(): BlockerAnswersHost | null {
  const own = use(BlockerAnswersContext);
  const dashboard = use(DashboardUiProvider);
  // Inside a Dashboard its answers win, so a card and a popover share one Undo and one receipt.
  return useMemo(
    () => (dashboard ? { answers: dashboard.answers, report: () => undefined } : own),
    [own, dashboard],
  );
}

const TONE = { red: "text-error", amber: "text-warning-foreground" } as const;

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

/** One red blocker: what blocks (a link), why, and its own button when it has one. */
function ThreadBlockerItem({
  blocker,
  scopeRootId,
  actions,
}: {
  readonly blocker: Blocker;
  readonly scopeRootId: ThreadId;
  readonly actions: BlockerActions;
}) {
  const { action } = blocker;
  const threadId = blocker.target.threadId;
  const resume =
    action?.type === "resume-plan"
      ? { label: "Resume from plan", run: () => actions.resumeFromPlan(action.threadId) }
      : action?.type === "resume-queue"
        ? { label: "Resume queue", run: () => actions.resumeThreadQueue(action.threadId) }
        : null;
  const pending =
    resume && threadId
      ? actions.pending.has(`${action?.type === "resume-queue" ? "queue" : "plan"}:${threadId}`)
      : false;
  return (
    <div className="flex flex-col gap-0.5 py-1" data-testid="blocker-item">
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-error">{KIND_WORD[blocker.kind]}:</span>
        {threadId ? (
          <span className={LINK_TEXT}>
            <InlineButton onClick={() => actions.openThread(threadId)}>{blocker.name}</InlineButton>
          </span>
        ) : (
          <span className={`${LINK_TEXT} font-medium`}>{blocker.name}</span>
        )}
        {blocker.owner && blocker.owner.threadId !== scopeRootId ? (
          <span className="shrink-0 text-muted-foreground">in {blocker.owner.name}</span>
        ) : null}
      </div>
      {blocker.reason ? (
        <div className="line-clamp-2 break-words text-muted-foreground">{blocker.reason}</div>
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
 * The red popover: each blocked or stopped thread under the row by name with its reason, one
 * button per resumable one, and one "Settle N" for the failed retries together. Derived from the
 * shells the sidebar already holds, so opening it costs no request.
 */
function ThreadBlockerList({
  environmentId,
  rootId,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly rootId: ThreadId;
  readonly actions: BlockerActions;
}) {
  const shells = useOrchestratorThreadShells();
  const permissions = useBlockerPermissions(environmentId);
  const [now] = useState(() => new Date().toISOString());
  const blockers = useMemo(
    () =>
      threadBlockers(
        shells.filter((shell) => shell.environmentId === environmentId),
        rootId,
        { ...permissions, now },
      ),
    [shells, environmentId, rootId, permissions, now],
  );
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? blockers : blockers.slice(0, SHOWN_FIRST);
  const settleIds = blockers.flatMap((blocker) =>
    blocker.action?.type === "settle" ? blocker.action.threadIds : [],
  );
  const settling = actions.pending.has("settle");
  return (
    <>
      <div className="font-medium">
        {blockers.length === 0 ? "No thread is blocked" : blockerHeadline(blockers)}
      </div>
      {shown.map((blocker) => (
        <ThreadBlockerItem
          key={blocker.key}
          blocker={blocker}
          scopeRootId={rootId}
          actions={actions}
        />
      ))}
      {!expanded && blockers.length > SHOWN_FIRST ? (
        <div>
          <InlineButton tone="muted" onClick={() => setExpanded(true)}>
            and {blockers.length - SHOWN_FIRST} more
          </InlineButton>
        </div>
      ) : null}
      {settleIds.length > 0 ? (
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={settling}
            onClick={() => void actions.settleThreads(settleIds)}
          >
            {settling ? "Settling" : `Settle ${settleIds.length}`}
          </Button>
        </div>
      ) : null}
      <Receipts actions={actions} />
    </>
  );
}

/**
 * The red "Blocked" on a row: opens the failed or held threads under it by name, with the one
 * action that clears each. Stays mounted so a Settle's receipt and Undo outlive the row's push.
 */
export function BlockedBadge({
  environmentId,
  rootId,
  active,
  label = "Blocked",
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly rootId: ThreadId;
  readonly active: boolean;
  readonly label?: string;
  readonly className?: string;
}) {
  const actions = useBlockerActions(environmentId);
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
      <ThreadBlockerList environmentId={environmentId} rootId={rootId} actions={actions} />
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

/** Rebuilds the Decisions row a snapshot attention belongs to, keyed as the Dashboard keys it. */
function rowFor(
  snapshot: Pick<DashboardSnapshot, "projects">,
  environmentId: EnvironmentId,
  blocker: Blocker,
): DecisionRow | null {
  const attention = blocker.attention;
  const project = snapshot.projects.find((candidate) =>
    candidate.attention.some((entry) => entry.id === blocker.key),
  );
  if (!attention || !project) return null;
  const key = `${environmentId}:${project.id}`;
  return { key: `${key}|${attention.id}`, scoped: { key, environmentId, project }, attention };
}

function WaitingItem({
  row,
  blocker,
  answers,
  onOpen,
}: {
  readonly row: DecisionRow;
  readonly blocker: Blocker;
  readonly answers: DecisionAnswers | null;
  readonly onOpen: () => void;
}) {
  const plan = useAnswerPlan(row);
  const state = answers?.stateOf(row.key) ?? null;
  if (answers && state) return <DecisionReceipt row={row} state={state} answers={answers} />;
  const { attention } = row;
  const summary = cardSummary(attention);
  const links =
    plan.mode === "questions" || plan.mode === "approval" ? null : (
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
      </div>
      {summary ? (
        <div className="line-clamp-2 break-words text-muted-foreground">{lead(summary)}</div>
      ) : null}
      {answers && blocker.action?.type === "answer" ? (
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
}: {
  readonly entries: ReadonlyArray<{ readonly row: DecisionRow; readonly blocker: Blocker }>;
  readonly headline: string;
  readonly asOf: string | null;
  /** True when the list comes from the copy stored on this device. */
  readonly stored: boolean;
  readonly openItem: (row: DecisionRow) => void;
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

/**
 * The amber "Waiting on Brad" for a row of the sidebar or a project list: the tracker items and
 * thread asks under `rootId`, from the Dashboard snapshot a mounted Dashboard holds, else the copy
 * stored on this device (labelled "as of" in the popover). The count and the list read the same
 * entries, so they always agree; a snapshot that has nothing falls back to the thread-level count
 * the shells carry, plain and without a list.
 */
export function WaitingBadge({
  environmentId,
  rootId,
  fallbackCount,
  openItem,
  className,
  compactLabel = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly rootId: ThreadId;
  /** The thread-level asks the shells count, used until a snapshot exists. */
  readonly fallbackCount: number;
  /** Where a click on an item's name goes; the default opens its issue or thread. */
  readonly openItem?: (row: DecisionRow) => void;
  readonly className?: string;
  /** Shortens "Waiting on Brad 12" to "12" below the row's container width. */
  readonly compactLabel?: boolean;
}) {
  const openDefault = useOpenDecisionRow();
  const { snapshot, stored } = useBlockerSnapshot(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const live = useLiveRuntimeRequests();
  const view = useMemo(() => {
    if (!snapshot) return null;
    const result = attentionBlockers(snapshot, rootId, { stored, canOperate });
    const blockers = result.blockers.filter(
      (blocker) =>
        blocker.attention &&
        liveAttention(environmentId, [blocker.attention], live, stored ? "cached" : "live").length >
          0,
    );
    const entries = blockers.flatMap((blocker) => {
      const row = rowFor(snapshot, environmentId, blocker);
      return row ? [{ row, blocker }] : [];
    });
    return { entries, headline: blockerHeadline(blockers), asOf: result.asOf };
  }, [snapshot, stored, canOperate, live, environmentId, rootId]);
  const count = view?.entries.length ?? 0;
  const host = useAnswersHost();
  const report = host?.report;
  const owner = `${environmentId}:${rootId}`;
  const liveKeys = view?.entries.map(({ row }) => row.key).join("\n") ?? "";
  // The keys this row lists, so a delivered answer stays answered while the snapshot still lags.
  useEffect(() => {
    report?.(owner, new Set(liveKeys ? liveKeys.split("\n") : []));
    return () => report?.(owner, null);
  }, [report, owner, liveKeys]);
  const [open, setOpen] = useState(false);
  if (count === 0 && !open)
    return fallbackCount > 0 ? (
      <span className={cn("shrink-0 tabular-nums text-warning-foreground", className)}>
        {fallbackCount}
      </span>
    ) : null;
  return (
    <BadgeShell
      tone="amber"
      label={
        <>
          <span className={compactLabel ? "hidden @min-[22rem]/row:inline" : undefined}>
            Waiting on Brad{" "}
          </span>
          <span className="tabular-nums">{count}</span>
        </>
      }
      ariaLabel={`Waiting on Brad, ${count}: the list and its answers`}
      className={className}
      settledLabel="Answered"
      active={count > 0}
      open={open}
      onOpenChange={setOpen}
    >
      <WaitingList
        entries={view?.entries ?? []}
        headline={view && count > 0 ? view.headline : "Waiting on Brad: nothing"}
        asOf={view?.asOf ?? null}
        stored={stored}
        openItem={openItem ?? openDefault}
      />
    </BadgeShell>
  );
}
