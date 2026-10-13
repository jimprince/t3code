import { useAtomValue } from "@effect/atom-react";
import { createDashboardAtoms } from "@t3tools/client-runtime/dashboard";
import type { DashboardSnapshot, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { mergeSnapshots, type DashboardData } from "../components/dashboard-v3/dashboard.logic";
import { useEnvironments } from "./environments";

const dashboard = createDashboardAtoms(connectionAtomRuntime);

/** One entry per connected environment; the key is the sorted ids so the atom is stable. */
const environmentsDashboard = Atom.family((key: string) =>
  Atom.make((get) =>
    key
      .split(",")
      .filter(Boolean)
      .map((environmentId) => ({
        environmentId: environmentId as EnvironmentId,
        state: get(dashboard.snapshot(environmentId as EnvironmentId)),
      })),
  ),
);

// The last good snapshot per environment survives a reload, so a cold start paints at once.
const STORAGE_PREFIX = "t3.dashboard.snapshot.";

function readStored(environmentId: EnvironmentId): DashboardSnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + environmentId);
    return raw ? (JSON.parse(raw) as DashboardSnapshot) : null;
  } catch {
    return null;
  }
}

const written = new Map<EnvironmentId, number>();

function writeStored(environmentId: EnvironmentId, snapshot: DashboardSnapshot) {
  if (written.get(environmentId) === snapshot.revision) return;
  written.set(environmentId, snapshot.revision);
  try {
    window.localStorage.setItem(STORAGE_PREFIX + environmentId, JSON.stringify(snapshot));
  } catch {
    // Private mode or a full quota: the page still has the live snapshot.
  }
}

export interface DashboardState {
  readonly data: DashboardData;
  /** At least one environment's refresh is failing; the last good snapshot is still shown. */
  readonly failed: boolean;
}

/**
 * Every connected environment's snapshot, merged. Renders the last good snapshot (live, else the
 * one stored on this device) and swaps in a newer revision in one go; there is no loading state.
 */
export function useDashboardData(): DashboardState {
  const { environments } = useEnvironments();
  const key = useMemo(
    () =>
      environments
        .map((environment) => environment.environmentId)
        .toSorted()
        .join(","),
    [environments],
  );
  const entries = useAtomValue(environmentsDashboard(key));
  useEffect(() => {
    for (const { environmentId, state } of entries)
      if (state.snapshot) writeStored(environmentId, state.snapshot);
  }, [entries]);
  return useMemo(() => {
    const parts = entries.map(({ environmentId, state }) => ({
      environmentId,
      snapshot: state.snapshot ?? readStored(environmentId),
    }));
    return {
      data: mergeSnapshots(parts),
      failed: entries.some(({ state }) => state.failed),
    };
  }, [entries]);
}
