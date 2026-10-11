import type { HarnessSnapshot } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { HARNESS_REFRESH_INTERVAL_MS } from "./harnessView.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Shared Harness query for the client UI. It refreshes while a view observes it and drops its
 * subscription when none does, so a hidden Harness tab costs nothing.
 */
export function createHarnessQuery<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "harness",
    tag: "harness.snapshot",
    staleTimeMs: 30_000,
    refreshIntervalMs: HARNESS_REFRESH_INTERVAL_MS,
    idleTtlMs: 0,
  });
}
/** @public Joins the snapshot rows consumed by the client Harness view. */
export function selectHarnessAgents(snapshot: HarnessSnapshot) {
  const routines = new Map(snapshot.routines.map((routine) => [routine.key, routine]));
  return snapshot.agents.map((agent) => ({
    ...agent,
    routines: agent.routineKeys.flatMap((key) => {
      const row = routines.get(key);
      return row ? [row] : [];
    }),
  }));
}
export type HarnessAgentRow = ReturnType<typeof selectHarnessAgents>[number];

/** Environment totals already include automated executions; never add routine runs again. */
export interface HarnessQueueSelection {
  readonly count: number;
  readonly oldestRequestedAt: string | null;
}

/** @public Older hosts and incomplete source reads cannot establish an exact queue. */
export function selectHarnessQueuedSends(
  snapshots: ReadonlyArray<HarnessSnapshot>,
): HarnessQueueSelection | null {
  const latest = new Map<string, HarnessSnapshot>();
  for (const snapshot of snapshots) {
    const previous = latest.get(snapshot.environmentId);
    if (!previous || snapshot.generatedAt >= previous.generatedAt)
      latest.set(snapshot.environmentId, snapshot);
  }
  if (latest.size === 0) return null;
  let count = 0;
  let oldestRequestedAt: string | null = null;
  for (const snapshot of latest.values()) {
    const queue = snapshot.queueSummary;
    if (!queue || queue.coverage !== "complete" || queue.queuedSendCount === null) return null;
    count += queue.queuedSendCount;
    if (
      queue.oldestQueuedRequestedAt !== null &&
      (oldestRequestedAt === null || queue.oldestQueuedRequestedAt < oldestRequestedAt)
    )
      oldestRequestedAt = queue.oldestQueuedRequestedAt;
  }
  return { count, oldestRequestedAt };
}
