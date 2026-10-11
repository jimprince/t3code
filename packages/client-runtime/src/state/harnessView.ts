import type {
  HarnessRoutine,
  HarnessRun,
  HarnessSnapshot,
  HarnessThreadLink,
} from "@t3tools/contracts";
import { formatLocalWhen } from "@t3tools/shared/localTime";
import {
  lastActivityAt,
  resolveThreadDisplayStatus,
  type OrchestratorSummary,
  type OrchestratorThreadShell,
  type ThreadDisplayStatus,
} from "./orchestrators.ts";
import { supervisionThreadKey } from "./forkNesting.ts";

/** The Harness tab polls its snapshot this often while it is visible. */
export const HARNESS_REFRESH_INTERVAL_MS = 60_000;
/** A snapshot older than this many refreshes is shown as stale rather than current. */
const STALE_AFTER_REFRESHES = 3;

/**
 * What a check's row claims. `healthy` is earned, never defaulted: it needs a finished,
 * non-dispatch run that completed, a schedule that is on time or event driven, and a source that
 * is not stale. Everything the data cannot prove is `unknown`.
 */
export type HarnessCheckState =
  | "failing"
  | "overdue"
  | "source-stale"
  | "unknown"
  | "not-shown"
  | "disabled"
  | "healthy";

export type HarnessTone = "error" | "warning" | "muted" | "ok";

const STATE_PRESENTATION: Record<
  HarnessCheckState,
  { readonly label: string; readonly tone: HarnessTone; readonly rank: number }
> = {
  failing: { label: "Failing", tone: "error", rank: 0 },
  overdue: { label: "Overdue", tone: "error", rank: 1 },
  "source-stale": { label: "Source stale", tone: "warning", rank: 2 },
  unknown: { label: "Unknown", tone: "warning", rank: 4 },
  healthy: { label: "Healthy", tone: "ok", rank: 5 },
  "not-shown": { label: "Not shown yet", tone: "muted", rank: 6 },
  disabled: { label: "Disabled", tone: "muted", rank: 7 },
};
/** A check whose findings count was above zero on every recent known run sorts with the failures. */
const ERRORS_EVERY_RUN_RANK = 3;
const ERRORS_EVERY_RUN_MIN_SAMPLES = 2;
const TREND_RUNS = 6;
const FINISHED_OUTCOMES: ReadonlySet<HarnessRun["outcome"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

export interface HarnessErrorsView {
  /** False when no recent run reported a findings count: the answer is "unknown", never zero. */
  readonly known: boolean;
  /** "unknown", "3.0 / run" or "0 / run". */
  readonly label: string;
  /** Oldest to newest counts of the last runs, `?` where a run reported none: "0 2 3 ?". */
  readonly trend: string;
  /** Findings on every recent known run, with at least two to say so. */
  readonly everyRun: boolean;
  /** Execution failures, separate from findings: "2 of 5 runs failed", null with no finished run. */
  readonly failedLabel: string | null;
}

export interface HarnessCheckView {
  readonly key: string;
  readonly name: string;
  readonly whatItChecks: string | null;
  readonly lifecycleLabel: "Standing" | "Conditional" | null;
  readonly contextLabel: "Persistent" | "New instance per run" | null;
  readonly schedule: string;
  readonly owner: HarnessThreadLink | null;
  readonly state: HarnessCheckState;
  readonly stateLabel: string;
  readonly tone: HarnessTone;
  /** Why the state is what it is: the lateness or source evidence behind the label. */
  readonly evidence: string;
  /** "Late 25m, 2 missed" on an overdue check. */
  readonly latenessLabel: string | null;
  /** "Not currently live" for a per-run agent between runs, "Running" while one is active. */
  readonly livenessLabel: string | null;
  readonly lastRunLabel: string | null;
  readonly nextLabel: string | null;
  readonly errors: HarnessErrorsView;
  readonly routine: HarnessRoutine;
  /** Sort position: lower needs a look sooner. */
  readonly rank: number;
}

/** "25m", "3h", "2d": the coarsest unit that is at least one. */
function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function latestFinished(routine: HarnessRoutine): HarnessRun | null {
  return routine.history.find((run) => !run.dryRun && FINISHED_OUTCOMES.has(run.outcome)) ?? null;
}

/** The state of one check and the evidence for it. Disabled and not-shown never read as healthy. */
export function classifyHarnessCheck(routine: HarnessRoutine): {
  readonly state: HarnessCheckState;
  readonly evidence: string;
} {
  if (routine.state === "not shown yet") {
    return { state: "not-shown", evidence: routine.lateness.evidence };
  }
  if (routine.state === "disabled" || routine.lateness.state === "disabled") {
    return { state: "disabled", evidence: routine.lateness.evidence };
  }
  const finished = latestFinished(routine);
  if (routine.state === "failing" || finished?.outcome === "failed") {
    return { state: "failing", evidence: finished?.evidence ?? "The latest run failed." };
  }
  if (routine.lateness.overdue === true) {
    return { state: "overdue", evidence: routine.lateness.evidence };
  }
  if (routine.sourceStale) {
    return {
      state: "source-stale",
      evidence: "The source behind this check has not refreshed; the last result may be old.",
    };
  }
  if (
    routine.state === "enabled" &&
    (routine.lateness.state === "on-time" || routine.lateness.state === "event-driven") &&
    finished?.outcome === "completed" &&
    finished.outcomeKind !== "dispatch"
  ) {
    return { state: "healthy", evidence: finished.evidence };
  }
  return {
    state: "unknown",
    evidence:
      finished === null
        ? "No finished run to judge by."
        : finished.outcomeKind === "dispatch"
          ? "Only a dispatch is recorded; dispatch is not execution success."
          : routine.lateness.state === "unknown"
            ? routine.lateness.evidence
            : `The latest run ended ${finished.outcome}.`,
  };
}

function errorsView(routine: HarnessRoutine): HarnessErrorsView {
  const { errorsPerRun, failedExecutions } = routine;
  // `recent` is newest first; the trend reads left to right in time.
  const newest = errorsPerRun.recent.slice(0, TREND_RUNS);
  const recent = newest.map((_, index) => newest[newest.length - 1 - index] ?? null);
  const known = errorsPerRun.knownSamples > 0;
  const knownCounts = errorsPerRun.recent.filter((count): count is number => count !== null);
  return {
    known,
    label:
      errorsPerRun.average === null
        ? "unknown"
        : `${Number.isInteger(errorsPerRun.average) ? errorsPerRun.average : errorsPerRun.average.toFixed(1)} / run`,
    trend: recent.map((count) => (count === null ? "?" : String(count))).join(" "),
    everyRun:
      knownCounts.length >= ERRORS_EVERY_RUN_MIN_SAMPLES && knownCounts.every((count) => count > 0),
    failedLabel:
      failedExecutions.sampleSize === 0
        ? null
        : `${failedExecutions.failures} of ${failedExecutions.sampleSize} runs failed`,
  };
}

function runInstant(run: HarnessRun): number {
  return Date.parse(run.finishedAt ?? run.startedAt ?? run.requestedAt);
}

/** One row per check with every label the list and its details need, in sidebar order. */
export function buildHarnessChecks(
  snapshots: ReadonlyArray<HarnessSnapshot>,
  now: number,
): ReadonlyArray<HarnessCheckView> {
  const rows = snapshots.flatMap((snapshot) =>
    snapshot.routines.map((routine): HarnessCheckView => {
      const { state, evidence } = classifyHarnessCheck(routine);
      const errors = errorsView(routine);
      const presentation = STATE_PRESENTATION[state];
      const last = routine.lastRun;
      const lateness = routine.lateness;
      return {
        key: routine.key,
        name: routine.name,
        whatItChecks: routine.whatItChecks,
        lifecycleLabel:
          routine.lifecycle === null
            ? null
            : routine.lifecycle === "standing"
              ? "Standing"
              : "Conditional",
        contextLabel:
          routine.context === null
            ? null
            : routine.context === "persistent"
              ? "Persistent"
              : "New instance per run",
        schedule: routine.scheduleOrTrigger,
        owner: routine.owner,
        state,
        stateLabel: presentation.label,
        tone: presentation.tone,
        evidence,
        latenessLabel:
          state === "overdue"
            ? [
                lateness.latenessMs === null ? "Late" : `Late ${formatSpan(lateness.latenessMs)}`,
                lateness.missedSlots === null || lateness.missedSlots === 0
                  ? null
                  : `${lateness.missedSlots} missed`,
              ]
                .filter((part) => part !== null)
                .join(", ")
            : null,
        livenessLabel:
          routine.liveness === "active"
            ? "Running"
            : routine.liveness === "not currently live" &&
                routine.context === "new-instance-per-run"
              ? "Not currently live"
              : null,
        lastRunLabel: last === null ? null : formatLocalWhen(runInstant(last), now),
        nextLabel:
          state === "disabled" || routine.nextExpectedRun === null
            ? null
            : formatLocalWhen(Date.parse(routine.nextExpectedRun), now),
        errors,
        routine,
        rank:
          errors.everyRun && (state === "healthy" || state === "unknown")
            ? ERRORS_EVERY_RUN_RANK
            : presentation.rank,
      };
    }),
  );
  return [...rows].sort(
    (left, right) =>
      left.rank - right.rank ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.key.localeCompare(right.key),
  );
}

export interface HarnessRunView {
  readonly key: string;
  readonly timeLabel: string;
  /** "Completed", "Failed", "Dispatched": a dispatch row never claims the run succeeded. */
  readonly outcomeLabel: string;
  readonly failed: boolean;
  /** "unknown" when the run reported no findings count. */
  readonly errorsLabel: string;
  readonly evidence: string;
  /** Opens the run's thread, scoped to its environment. */
  readonly thread: HarnessThreadLink | null;
}

/** The details panel's run history, newest first, as the snapshot bounded it. */
export function buildHarnessRunRows(
  routine: HarnessRoutine,
  now: number,
): ReadonlyArray<HarnessRunView> {
  return routine.history.map((run) => ({
    key: run.key,
    timeLabel: formatLocalWhen(runInstant(run), now),
    outcomeLabel:
      run.outcomeKind === "dispatch" && run.outcome === "completed"
        ? "Dispatched"
        : `${run.outcome.charAt(0).toUpperCase()}${run.outcome.slice(1)}`,
    failed: run.outcome === "failed",
    errorsLabel: run.errorCount === null ? "unknown" : String(run.errorCount),
    evidence: run.evidence,
    thread: run.threads[0] ?? null,
  }));
}

/** How current the shown data is: its read time, and whether it is old enough to doubt. */
export function describeHarnessFreshness(
  generatedAt: string | null,
  now: number,
): { readonly label: string; readonly stale: boolean } {
  if (generatedAt === null) return { label: "not loaded", stale: true };
  const at = Date.parse(generatedAt);
  return {
    label: `read ${formatLocalWhen(at, now)}`,
    stale: now - at > HARNESS_REFRESH_INTERVAL_MS * STALE_AFTER_REFRESHES,
  };
}

/** Sources the snapshot could not read fresh, for the one line that says some rows are not current. */
export function staleHarnessSources(snapshots: ReadonlyArray<HarnessSnapshot>): number {
  return snapshots.reduce(
    (total, snapshot) =>
      total + snapshot.sources.filter((source) => source.status !== "available").length,
    0,
  );
}

export type HarnessAgentBucket = "failed" | "needs-you" | "working" | "idle";
const AGENT_BUCKET_RANK: Record<HarnessAgentBucket, number> = {
  failed: 0,
  "needs-you": 1,
  working: 2,
  idle: 3,
};

export interface HarnessAgentView {
  readonly key: string;
  readonly thread: OrchestratorThreadShell;
  readonly summary: OrchestratorSummary | null;
  readonly status: ThreadDisplayStatus;
  readonly bucket: HarnessAgentBucket;
  readonly needsYou: number;
  /** Workers whose latest run failed and that nothing has picked up again. */
  readonly blocked: number;
  readonly working: number;
  readonly latestActivityAt: string;
}

const isSummary = (
  entry: OrchestratorSummary | OrchestratorThreadShell,
): entry is OrchestratorSummary => "root" in entry;

/** The one thing a row says about an agent, most urgent first: "failed", "2 blocked", "1 needs you", "3 run". */
export function describeHarnessAgent(
  agent: HarnessAgentView,
): { readonly text: string; readonly tone: "error" | "warning" | "info" } | null {
  if (agent.status === "failed") return { text: "failed", tone: "error" };
  if (agent.needsYou > 0) return { text: `${agent.needsYou} needs you`, tone: "warning" };
  if (agent.blocked > 0) return { text: `${agent.blocked} blocked`, tone: "error" };
  if (agent.bucket === "working") {
    return { text: agent.working > 0 ? `${agent.working} run` : "working", tone: "info" };
  }
  return null;
}

/**
 * Harness roots from the purpose partition, needs-attention first: failed, needs you, working,
 * then idle, which the list folds like Quiet. Pinned roots lead their bucket.
 */
export function buildHarnessAgents(
  roots: ReadonlyArray<OrchestratorSummary | OrchestratorThreadShell>,
): ReadonlyArray<HarnessAgentView> {
  const rows = roots.map((entry): HarnessAgentView => {
    const thread = isSummary(entry) ? entry.root : entry;
    const status = isSummary(entry)
      ? entry.status
      : resolveThreadDisplayStatus({ ...entry, hasActiveDescendants: false });
    const needsYou = isSummary(entry)
      ? entry.rollup.needsYou
      : status === "approval" || status === "input"
        ? 1
        : 0;
    const working = isSummary(entry) ? entry.rollup.working : 0;
    const blocked = isSummary(entry) ? entry.rollup.blocked : 0;
    const bucket: HarnessAgentBucket =
      status === "failed" || (blocked > 0 && needsYou === 0)
        ? "failed"
        : needsYou > 0
          ? "needs-you"
          : working > 0 || status !== "ready"
            ? "working"
            : "idle";
    return {
      key: supervisionThreadKey(thread),
      thread,
      summary: isSummary(entry) ? entry : null,
      status,
      bucket,
      needsYou,
      blocked,
      working,
      latestActivityAt: isSummary(entry) ? entry.rollup.latestActivityAt : lastActivityAt(thread),
    };
  });
  return [...rows].sort(
    (left, right) =>
      AGENT_BUCKET_RANK[left.bucket] - AGENT_BUCKET_RANK[right.bucket] ||
      Number(right.thread.pinnedAt != null) - Number(left.thread.pinnedAt != null) ||
      left.thread.title.localeCompare(right.thread.title, undefined, { sensitivity: "base" }) ||
      left.key.localeCompare(right.key),
  );
}
