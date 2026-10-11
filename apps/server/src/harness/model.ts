import {
  ThreadId,
  type EnvironmentId,
  type HarnessAgent,
  type HarnessLateness,
  type HarnessRoutine,
  type HarnessRun,
  type HarnessThreadLink,
  type HarnessTrend,
} from "@t3tools/contracts";

export function threadLink(
  environmentId: EnvironmentId,
  threadId: string,
  runId: string | null = null,
  messageId: string | null = null,
): HarnessThreadLink {
  return {
    environmentId,
    threadId: ThreadId.make(threadId),
    runId,
    messageId,
    href: `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
  };
}
export function trend(
  runs: readonly HarnessRun[],
  metric: "errorCount" | "runtimeErrorCount",
): HarnessTrend {
  const recent = runs
    .filter(
      (run) =>
        !run.dryRun &&
        run.outcomeKind === "execution" &&
        ["completed", "failed", "interrupted", "cancelled"].includes(run.outcome),
    )
    .map((run) => run[metric]);
  const known = recent.filter((count) => count !== null);
  return {
    sampleSize: recent.length,
    knownSamples: known.length,
    missingSamples: recent.length - known.length,
    average: known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length,
    recent,
  };
}

/** Enumerate bounded calendar slots with the scheduler's own timezone-aware successor. */
export function lateness(input: {
  enabled: boolean;
  now: string;
  nextRunAt: string | null;
  windowStart: string | null;
  next: (after: string) => string | null;
  runs: readonly HarnessRun[];
  graceMs: number;
}): HarnessLateness {
  const base = {
    since: null,
    latenessMs: null,
    graceMs: input.graceMs,
    missedSlots: null,
    sampleSize: input.runs.length,
    coverage: "unknown" as const,
  };
  if (!input.enabled)
    return {
      ...base,
      state: "disabled",
      overdue: false,
      evidence: "Disabled; stored nextRunAt is ignored.",
    };
  if (input.nextRunAt === null && input.next(input.now) === null)
    return {
      ...base,
      state: "event-driven",
      overdue: null,
      evidence: "No unconditional schedule or event SLA.",
    };
  if (input.windowStart === null)
    return { ...base, state: "unknown", overdue: null, evidence: "No coherent schedule window." };
  const cutoff = Date.parse(input.now) - input.graceMs;
  const occupied = new Set(
    input.runs
      .filter((run) => !run.dryRun && run.outcome !== "skipped")
      .map((run) => run.expectedAt),
  );
  let slot: string | null = input.windowStart;
  let sampled = 0;
  let missed = 0;
  let latestMissing: string | null = null;
  let lastSlot: string | null = null;
  while (slot !== null && Date.parse(slot) <= cutoff && sampled < 1000) {
    sampled += 1;
    lastSlot = slot;
    if (!occupied.has(slot)) {
      missed += 1;
      latestMissing = slot;
    }
    const next = input.next(slot);
    if (next !== null && Date.parse(next) <= Date.parse(slot))
      return { ...base, state: "unknown", overdue: null, evidence: "Schedule did not advance." };
    slot = next;
  }
  const bounded = slot !== null && Date.parse(slot) <= cutoff;
  const dispatched = input.runs.filter(
    (run) => !run.dryRun && run.expectedAt === lastSlot && run.outcome !== "skipped",
  );
  const lateStart =
    !bounded &&
    lastSlot !== null &&
    dispatched.length > 0 &&
    dispatched.every(
      (run) =>
        run.outcomeKind === "execution" && run.outcome === "queued" && run.startedAt === null,
    );
  const uncertainStart =
    !bounded &&
    lastSlot !== null &&
    dispatched.length > 0 &&
    dispatched.every((run) => run.outcomeKind === "dispatch");
  const overdue =
    !bounded &&
    ((latestMissing !== null &&
      latestMissing === lastSlot &&
      input.nextRunAt !== null &&
      Date.parse(input.nextRunAt) <= cutoff) ||
      lateStart);
  const since = overdue ? (lateStart ? lastSlot : latestMissing) : null;
  return {
    ...base,
    phase:
      bounded || uncertainStart ? "unknown" : lateStart ? "start" : overdue ? "dispatch" : "none",
    state: bounded || uncertainStart ? "unknown" : overdue ? "overdue" : "on-time",
    overdue: bounded || uncertainStart ? null : overdue,
    since,
    latenessMs: overdue ? Math.max(0, Date.parse(input.now) - Date.parse(since!)) : null,
    missedSlots: missed,
    sampleSize: sampled,
    coverage: "bounded",
    evidence: `${sampled} expected slots inspected; ${missed} unrepresented/skipped slots${bounded ? " (lower bound; enumeration capped at 1000)" : ""}. ${lateStart ? "Exact queued execution has not started. " : uncertainStart ? "Dispatch exists but execution-start evidence is unavailable. " : ""}Dispatch is not execution success; history, schedule edits and disabled intervals limit coverage. A future pending slot does not become overdue because of historical gaps.`,
  };
}

export function routine(
  input: Pick<HarnessRoutine, "key" | "name" | "environmentId" | "source"> &
    Partial<HarnessRoutine>,
): HarnessRoutine {
  const history = [...(input.history ?? [])].sort((a, b) =>
    b.requestedAt.localeCompare(a.requestedAt),
  );
  const final = history.filter(
    (run) =>
      !run.dryRun &&
      run.outcomeKind === "execution" &&
      ["completed", "failed"].includes(run.outcome),
  );
  const failures = final.filter((run) => run.outcome !== "completed").length;
  const activeRuns = input.activeRuns ?? [];
  const lastRun = history[0] ?? null;
  return {
    agentKey: null,
    whatItChecks: null,
    projectId: null,
    owner: null,
    purpose: "unclassified",
    sourceStale: false,
    state: "unknown",
    lifecycle: null,
    context: null,
    scheduleOrTrigger: "unknown",
    nextExpectedRun: null,
    lateness: {
      state: "unknown",
      overdue: null,
      since: null,
      latenessMs: null,
      graceMs: 0,
      missedSlots: null,
      sampleSize: 0,
      coverage: "unknown",
      evidence: "No typed owner schedule receipt.",
    },
    liveness: "unknown",
    historyCoverage: {
      retainedFrom: history.at(-1)?.requestedAt ?? null,
      truncated: true,
      evidence: "Bounded retained history; not lifetime coverage.",
    },
    ...input,
    history,
    activeRuns,
    lastRun,
    errorsPerRun: trend(history, "errorCount"),
    runtimeErrorsPerRun: trend(history, "runtimeErrorCount"),
    failedExecutions: {
      sampleSize: final.length,
      failures,
      rate: final.length ? failures / final.length : null,
    },
    latestOutput: lastRun?.threads[0] ?? null,
  };
}

/** Persistent targets share one row across schedules; per-run threads never become rows. */
export function groupAgents(
  routines: readonly HarnessRoutine[],
  standing: readonly HarnessAgent[] = [],
  names: ReadonlyMap<string, string> = new Map(),
): HarnessAgent[] {
  const agents = new Map(
    standing.map((agent) => [agent.key, { ...agent, routineKeys: [...agent.routineKeys] }]),
  );
  for (const row of routines) {
    if (row.agentKey === null) continue;
    const existing = agents.get(row.agentKey);
    if (existing) {
      existing.routineKeys.push(row.key);
      if (row.liveness === "active") existing.liveness = "active";
      else if (row.liveness === "unknown" && existing.liveness !== "active")
        existing.liveness = "unknown";
    } else
      agents.set(row.agentKey, {
        key: row.agentKey,
        name: names.get(row.agentKey) ?? row.name,
        environmentId: row.environmentId,
        lifecycle: row.lifecycle,
        context: row.context,
        thread:
          row.context === "persistent"
            ? row.agentKey.startsWith(`${row.environmentId}:thread:`)
              ? threadLink(
                  row.environmentId,
                  row.agentKey.slice(`${row.environmentId}:thread:`.length),
                )
              : row.owner
            : null,
        routineKeys: [row.key],
        liveness: row.liveness,
      });
  }
  return [...agents.values()].sort((a, b) => a.key.localeCompare(b.key));
}
