import type { HarnessRoutine, HarnessRun, HarnessSnapshot } from "@t3tools/contracts";
import type { HarnessQueueSelection } from "./harnessQuery.ts";
import { formatSpan, SNAPSHOT_STALE_AFTER_MS, type HarnessTone } from "./harnessView.ts";

/** Oldest queued item waiting longer than this turns the wait amber: a run that should have started. */
export const HARNESS_QUEUE_WAIT_WARN_MS = 10 * 60_000;
const FAILED_WINDOW_MS = 24 * 60 * 60_000;

/** Complete environment queue totals, including automation executions. */
export type HarnessQueuedSends = HarnessQueueSelection;

export interface HarnessStripInput {
  readonly snapshots: ReadonlyArray<HarnessSnapshot>;
  readonly now: number;
  /** Environments whose last refresh failed. */
  readonly unreachable?: ReadonlySet<string>;
  /** Environments that serve the snapshot but have not answered yet or failed with no last read. */
  readonly missingEnvironments?: number;
  /** Complete snapshot queue summary; null for older hosts or incomplete reads. */
  readonly queuedSends?: HarnessQueuedSends | null;
}

export interface HarnessStripPart {
  readonly label: "Queue" | "Oldest wait" | "Failed 24h";
  readonly value: string;
  readonly tone: HarnessTone;
}

export interface HarnessStripView {
  readonly parts: ReadonlyArray<HarnessStripPart>;
  /** The whole line as plain text: "Queue 4 · Oldest wait 9m · Failed 24h 2". */
  readonly text: string;
  /** A read is old or its host is not answering: the strip dims and says so. */
  readonly stale: boolean;
}

const runTime = (run: HarnessRun) => Date.parse(run.finishedAt ?? run.startedAt ?? run.requestedAt);

/** Harness checks only: an ownerless routine is not Harness and does not feed its strip. */
const stripRoutines = (snapshot: HarnessSnapshot): ReadonlyArray<HarnessRoutine> =>
  snapshot.routines.filter((routine) => routine.purpose !== "unclassified");

/**
 * A run counts once even when it is in both a routine's active runs and its bounded history.
 * Routine rows only provide a fallback lower bound when the environment queue is unknown.
 */
function queuedRuns(snapshots: ReadonlyArray<HarnessSnapshot>): ReadonlyArray<HarnessRun> {
  const byKey = new Map<string, HarnessRun>();
  for (const snapshot of snapshots) {
    for (const routine of stripRoutines(snapshot)) {
      for (const run of routine.activeRuns) {
        if (run.outcome === "queued" && !run.dryRun) byKey.set(`${routine.key}:${run.key}`, run);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Failed executions in the last 24 hours across the checks. A routine's history is bounded, so when
 * it is truncated and its oldest retained run is inside the window, older failures may be missing:
 * the count is then a lower bound, never a silent undercount.
 */
function failedInWindow(
  snapshots: ReadonlyArray<HarnessSnapshot>,
  now: number,
): { readonly count: number; readonly lowerBound: boolean } {
  const since = now - FAILED_WINDOW_MS;
  let count = 0;
  let lowerBound = false;
  for (const snapshot of snapshots) {
    for (const routine of stripRoutines(snapshot)) {
      count += routine.history.filter(
        (run) =>
          !run.dryRun &&
          run.outcomeKind === "execution" &&
          run.outcome === "failed" &&
          runTime(run) >= since,
      ).length;
      const { truncated, retainedFrom } = routine.historyCoverage;
      if (truncated && (retainedFrom === null || Date.parse(retainedFrom) > since)) {
        lowerBound = true;
      }
    }
  }
  return { count, lowerBound };
}

/**
 * The one line above the Harness view: queue depth, how long the oldest queued item has waited, and
 * failed runs in 24 hours. A part the data cannot prove says unknown or "at least", never zero.
 * Tones: the wait is amber past HARNESS_QUEUE_WAIT_WARN_MS and failures are red; nothing is green.
 */
export function buildHarnessStrip(input: HarnessStripInput): HarnessStripView {
  const { snapshots, now } = input;
  const sends = input.queuedSends ?? null;
  const partial = (input.missingEnvironments ?? 0) > 0;
  const answered = snapshots.length > 0;
  const stale =
    answered &&
    (snapshots.some(
      (snapshot) =>
        now - Date.parse(snapshot.generatedAt) > SNAPSHOT_STALE_AFTER_MS ||
        (input.unreachable?.has(snapshot.environmentId) ?? false),
    ) ||
      partial);

  const runs = queuedRuns(snapshots);
  const oldestRun = Math.min(...runs.map((run) => Date.parse(run.requestedAt)));
  const oldestSend =
    sends?.oldestRequestedAt == null
      ? Number.POSITIVE_INFINITY
      : Date.parse(sends.oldestRequestedAt);
  // The environment total already includes queued automation executions.
  const oldest = sends === null ? oldestRun : oldestSend;
  const queued = sends?.count ?? runs.length;

  let queueValue: string;
  if (!answered) queueValue = "unknown";
  else {
    const atLeast = partial ? "at least " : "";
    queueValue =
      sends === null
        ? `${atLeast}${runs.length} ${runs.length === 1 ? "run" : "runs"}, sends unknown`
        : `${atLeast}${queued}`;
  }

  let waitValue: string;
  let waitTone: HarnessTone = "muted";
  if (!answered || (Number.isFinite(oldest) === false && sends === null)) {
    waitValue = "unknown";
  } else if (!Number.isFinite(oldest)) {
    waitValue = partial ? "unknown" : "none";
  } else {
    const wait = Math.max(0, now - oldest);
    // Unread sends may be older than the oldest run, so the wait is a floor.
    waitValue = `${formatSpan(wait)}${sends === null || partial ? "+" : ""}`;
    if (wait >= HARNESS_QUEUE_WAIT_WARN_MS) waitTone = "warning";
  }

  const failed = failedInWindow(snapshots, now);
  let failedValue: string;
  let failedTone: HarnessTone = "muted";
  if (!answered || ((failed.lowerBound || partial) && failed.count === 0)) failedValue = "unknown";
  else {
    failedValue = `${failed.lowerBound || partial ? "at least " : ""}${failed.count}`;
    if (failed.count > 0) failedTone = "error";
  }

  const parts: HarnessStripPart[] = [
    { label: "Queue", value: queueValue, tone: "muted" },
    { label: "Oldest wait", value: waitValue, tone: waitTone },
    { label: "Failed 24h", value: failedValue, tone: failedTone },
  ];
  return {
    parts,
    text: `${parts.map((part) => `${part.label} ${part.value}`).join(" · ")}${stale ? " · stale" : ""}`,
    stale,
  };
}
