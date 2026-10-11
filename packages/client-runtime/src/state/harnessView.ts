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
const SNAPSHOT_STALE_AFTER_MS = HARNESS_REFRESH_INTERVAL_MS * STALE_AFTER_REFRESHES;

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
  /** "Conditional · New instance per run · every 30 min". */
  readonly classification: string;
  /** "last 13:40 · next 14:10 · Not currently live". */
  readonly timing: string;
  /** "errors 2.5 / run (1 2 3 4)" or "errors unknown". */
  readonly errorsText: string;
  /** The row's whole story for a screen reader: name, state, lateness, classification, timing, errors. */
  readonly spokenLabel: string;
  /** No owner classified it; listed apart from the Harness checks. */
  readonly unclassified: boolean;
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

/** The newest real run that has ended or been dispatched: queued and running ones are still pending. */
function latestSettled(routine: HarnessRoutine): HarnessRun | null {
  return (
    routine.history.find(
      (run) => !run.dryRun && run.outcome !== "queued" && run.outcome !== "running",
    ) ?? null
  );
}

/** What the client knows beyond the snapshot rows: how old the read is and whether its host answers. */
export interface HarnessClassifyContext {
  readonly now: number;
  /** When the snapshot behind this routine was generated. */
  readonly generatedAt: string;
  /** The environment's last refresh failed or it is not connected. */
  readonly unreachable: boolean;
}

/**
 * The state of one check and the evidence for it. Disabled and not-shown never read as healthy,
 * and neither does anything the client can no longer confirm: a snapshot that is old or whose
 * host stopped answering is source-stale, and a slot that passed with nothing newer read is overdue.
 */
export function classifyHarnessCheck(
  routine: HarnessRoutine,
  context: HarnessClassifyContext,
): {
  readonly state: HarnessCheckState;
  readonly evidence: string;
  /** Client-derived lateness, when the server's own reading was on time but the clock moved on. */
  readonly lateSinceMs?: number;
} {
  if (routine.state === "not shown yet") {
    return { state: "not-shown", evidence: routine.lateness.evidence };
  }
  if (routine.state === "disabled" || routine.lateness.state === "disabled") {
    return { state: "disabled", evidence: routine.lateness.evidence };
  }
  const settled = latestSettled(routine);
  if (routine.state === "failing" || settled?.outcome === "failed") {
    return { state: "failing", evidence: settled?.evidence ?? "The latest run failed." };
  }
  if (routine.lateness.overdue === true) {
    return { state: "overdue", evidence: routine.lateness.evidence };
  }
  // The snapshot's lateness is frozen at generatedAt. Once the next expected slot has passed by the
  // grace and one refresh, and nothing newer has been read, the check is late whatever it said then.
  if (
    routine.lateness.state === "on-time" &&
    routine.nextExpectedRun !== null &&
    context.now >
      Date.parse(routine.nextExpectedRun) +
        Math.max(routine.lateness.graceMs, HARNESS_REFRESH_INTERVAL_MS)
  ) {
    const late = context.now - Date.parse(routine.nextExpectedRun);
    return {
      state: "overdue",
      evidence: `Expected ${formatLocalWhen(Date.parse(routine.nextExpectedRun), context.now)}; no newer read shows it ran (last read ${formatLocalWhen(Date.parse(context.generatedAt), context.now)}).`,
      lateSinceMs: late,
    };
  }
  if (
    routine.sourceStale ||
    context.unreachable ||
    context.now - Date.parse(context.generatedAt) > SNAPSHOT_STALE_AFTER_MS
  ) {
    return {
      state: "source-stale",
      evidence: routine.sourceStale
        ? "The source behind this check has not refreshed; the last result may be old."
        : `Last read ${formatLocalWhen(Date.parse(context.generatedAt), context.now)}${context.unreachable ? ", and the host is not answering" : ""}; cannot confirm.`,
    };
  }
  if (
    routine.state === "enabled" &&
    (routine.lateness.state === "on-time" || routine.lateness.state === "event-driven") &&
    settled?.outcome === "completed" &&
    settled.outcomeKind !== "dispatch"
  ) {
    return { state: "healthy", evidence: settled.evidence };
  }
  return {
    state: "unknown",
    evidence:
      settled === null
        ? "No run to judge by."
        : settled.outcomeKind === "dispatch"
          ? "The newest run is only a dispatch; dispatch is not execution success."
          : settled.outcome === "unknown" || settled.outcome === "skipped"
            ? `The newest run is ${settled.outcome}, so an older run cannot vouch for it.`
            : routine.lateness.state === "unknown"
              ? routine.lateness.evidence
              : `The latest run ended ${settled.outcome}.`,
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

/** What the client adds to the snapshots: environments whose last refresh failed or that are not connected. */
export interface HarnessBuildOptions {
  readonly unreachable?: ReadonlySet<string>;
}

/** One row per check with every label the list and its details need, in sidebar order. */
export function buildHarnessChecks(
  snapshots: ReadonlyArray<HarnessSnapshot>,
  now: number,
  options: HarnessBuildOptions = {},
): ReadonlyArray<HarnessCheckView> {
  const rows = snapshots.flatMap((snapshot) =>
    snapshot.routines.map((routine): HarnessCheckView => {
      const { state, evidence, lateSinceMs } = classifyHarnessCheck(routine, {
        now,
        generatedAt: snapshot.generatedAt,
        unreachable: options.unreachable?.has(snapshot.environmentId) ?? false,
      });
      const errors = errorsView(routine);
      const presentation = STATE_PRESENTATION[state];
      // Healthy with no findings signal only says it ran on time: a green word beside "errors
      // unknown" would read as "no errors".
      const onTimeOnly = state === "healthy" && !errors.known;
      const stateLabel = onTimeOnly ? "On time" : presentation.label;
      const tone: HarnessTone = onTimeOnly ? "muted" : presentation.tone;
      const last = routine.lastRun;
      const lateness = routine.lateness;
      const latenessMs = lateSinceMs ?? lateness.latenessMs;
      const latenessLabel =
        state === "overdue"
          ? [
              latenessMs === null ? "Late" : `Late ${formatSpan(latenessMs)}`,
              lateSinceMs !== undefined ||
              lateness.missedSlots === null ||
              lateness.missedSlots === 0
                ? null
                : `${lateness.missedSlots} missed`,
            ]
              .filter((part) => part !== null)
              .join(", ")
          : null;
      const lifecycleLabel =
        routine.lifecycle === null
          ? null
          : routine.lifecycle === "standing"
            ? "Standing"
            : "Conditional";
      const contextLabel =
        routine.context === null
          ? null
          : routine.context === "persistent"
            ? "Persistent"
            : "New instance per run";
      const livenessLabel =
        routine.liveness === "active"
          ? "Running"
          : routine.liveness === "not currently live" && routine.context === "new-instance-per-run"
            ? "Not currently live"
            : null;
      const lastRunLabel = last === null ? null : formatLocalWhen(runInstant(last), now);
      const nextLabel =
        state === "disabled" || routine.nextExpectedRun === null
          ? null
          : formatLocalWhen(Date.parse(routine.nextExpectedRun), now);
      const classification = [lifecycleLabel, contextLabel, routine.scheduleOrTrigger]
        .filter((part) => part !== null && part !== "")
        .join(" · ");
      const timing = [
        lastRunLabel ? `last ${lastRunLabel}` : "no run yet",
        nextLabel ? `next ${nextLabel}` : null,
        livenessLabel,
      ]
        .filter((part) => part !== null)
        .join(" · ");
      const errorsText = `errors ${errors.label}${errors.known && errors.trend ? ` (${errors.trend})` : ""}`;
      return {
        key: routine.key,
        name: routine.name,
        whatItChecks: routine.whatItChecks,
        lifecycleLabel,
        contextLabel,
        schedule: routine.scheduleOrTrigger,
        classification,
        timing,
        errorsText,
        // A button's label replaces its contents for a screen reader, so it carries them all.
        spokenLabel: [
          routine.name,
          latenessLabel === null ? stateLabel : `${stateLabel}, ${latenessLabel}`,
          routine.purpose === "unclassified" ? "Unclassified" : null,
          classification,
          timing,
          errorsText,
        ]
          .filter((part) => part !== null && part !== "")
          .join(", "),
        unclassified: routine.purpose === "unclassified",
        owner: routine.owner,
        state,
        stateLabel,
        tone,
        evidence,
        latenessLabel,
        livenessLabel,
        lastRunLabel,
        nextLabel,
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

/**
 * Harness checks and, apart, routines no owner has classified (an ownerless schedule): those are
 * listed in their own labeled group instead of passing as Harness checks.
 */
export function splitHarnessChecks(checks: ReadonlyArray<HarnessCheckView>): {
  readonly harness: ReadonlyArray<HarnessCheckView>;
  readonly unclassified: ReadonlyArray<HarnessCheckView>;
} {
  return {
    harness: checks.filter((check) => !check.unclassified),
    unclassified: checks.filter((check) => check.unclassified),
  };
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

/**
 * The header's source notes: sources that could not be read fresh ("2 sources stale"), and ones the
 * host never set up ("1 not configured"), which is not a fault and is not called stale.
 */
export function describeHarnessSources(snapshots: ReadonlyArray<HarnessSnapshot>): string[] {
  const statuses = snapshots.flatMap((snapshot) => snapshot.sources.map((source) => source.status));
  const stale = statuses.filter((status) => status !== "available" && status !== "not-configured");
  const unconfigured = statuses.filter((status) => status === "not-configured");
  const plural = (count: number) => (count === 1 ? "" : "s");
  return [
    stale.length > 0 ? `${stale.length} source${plural(stale.length)} stale` : null,
    unconfigured.length > 0 ? `${unconfigured.length} not configured` : null,
  ].filter((part) => part !== null);
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

/** An agent row's label for a screen reader: its title and the status the dot and badge show. */
export function spokenHarnessAgent(agent: HarnessAgentView): string {
  const status = describeHarnessAgent(agent);
  return status === null
    ? `Open ${agent.thread.title}`
    : `Open ${agent.thread.title}, ${status.text}`;
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
