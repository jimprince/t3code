import { useAtomValue } from "@effect/atom-react";
import {
  createDashboardAtoms,
  createDashboardSnapshotMerger,
  mountedDashboardSnapshotAtom,
} from "@t3tools/client-runtime/dashboard";
import { DashboardSnapshot, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { type DashboardData } from "../components/dashboard-v3/dashboard.logic";
import { useEnvironments } from "./environments";

import { serverEnvironment } from "./server";
import { environmentSnapshotAtom } from "./shell";
import { supervision } from "./forkSupervision";
import { environmentThreadShells } from "./threads";

const remoteParentThreadIds = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const active = new Set(
      get(environmentThreadShells.threadShellsAtom)
        .filter((thread) => thread.archivedAt === null)
        .map((thread) => `${thread.environmentId}:${thread.id}`),
    );
    return [
      ...new Set(
        get(supervision.metadata).flatMap((row) =>
          row.remoteParent?.environmentId === environmentId &&
          active.has(`${row.environmentId}:${row.threadId}`)
            ? [row.remoteParent.threadId]
            : [],
        ),
      ),
    ].toSorted();
  }).pipe(Atom.setIdleTTL(0)),
);
const dashboard = createDashboardAtoms(connectionAtomRuntime, {
  config: serverEnvironment.configValueAtom,
  shell: environmentSnapshotAtom,
  readCached: readStored,
  remoteParentThreadIds,
});

const mergeStable = createDashboardSnapshotMerger();

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
  ).pipe(Atom.setIdleTTL(0)),
);

// The last good snapshot per environment survives a reload, so a cold start paints at once.
const STORAGE_PREFIX = "t3.dashboard.snapshot.";

const decodeDashboardSnapshot = Schema.decodeUnknownSync(DashboardSnapshot);

function readStored(environmentId: EnvironmentId): DashboardSnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + environmentId);
    return raw ? decodeDashboardSnapshot(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

const written = new Map<EnvironmentId, number>();

/** The stored copy as an atom, so a badge reads it without a subscription and sees a new write. */
const storedDashboardSnapshot = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<DashboardSnapshot | null>(readStored(environmentId)).pipe(Atom.keepAlive),
);

function writeStored(environmentId: EnvironmentId, snapshot: DashboardSnapshot) {
  if (written.get(environmentId) === snapshot.revision) return;
  written.set(environmentId, snapshot.revision);
  appAtomRegistry.set(storedDashboardSnapshot(environmentId), snapshot);
  try {
    window.localStorage.setItem(STORAGE_PREFIX + environmentId, JSON.stringify(snapshot));
  } catch {
    // Private mode or a full quota: the page still has the live snapshot.
  }
}

export interface DashboardState {
  readonly data: DashboardData;
  readonly revision: string;
  readonly snapshotSource: "cached" | "live" | "empty";
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
      data: mergeStable(parts),
      revision: parts.map((p) => `${p.environmentId}:${p.snapshot?.revision ?? 0}`).join(","),
      snapshotSource: parts.some((p) => p.snapshot)
        ? entries.some((e) => e.state.source === "live")
          ? "live"
          : "cached"
        : "empty",
    };
  }, [entries]);
}

const NO_DASHBOARD_SNAPSHOT = Atom.make<DashboardSnapshot | null>(null);
const environmentDashboardSnapshot = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(dashboard.snapshot(environmentId)).snapshot).pipe(Atom.setIdleTTL(0)),
);

const NO_DASHBOARD_SOURCE = Atom.make<"cached" | "live" | "empty">("empty");
const environmentDashboardSource = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(dashboard.snapshot(environmentId)).source).pipe(Atom.setIdleTTL(0)),
);

/** Whether one environment's snapshot is live, stored on this device, or missing. */
export function useEnvironmentDashboardSource(
  environmentId: EnvironmentId | null,
): "cached" | "live" | "empty" {
  return useAtomValue(
    environmentId === null ? NO_DASHBOARD_SOURCE : environmentDashboardSource(environmentId),
  );
}

/** Re-reads an environment's dashboard, for a card whose answer found the snapshot stale. */
export function refreshDashboard(environmentId: EnvironmentId): void {
  dashboard.retry(appAtomRegistry, environmentId);
}

/** One environment's last live snapshot; the Chief of Staff tray counts its decisions from it. */
export function useEnvironmentDashboardSnapshot(
  environmentId: EnvironmentId | null,
): DashboardSnapshot | null {
  return useAtomValue(
    environmentId === null ? NO_DASHBOARD_SNAPSHOT : environmentDashboardSnapshot(environmentId),
  );
}

const NO_BLOCKER_SNAPSHOT = Atom.make<DashboardSnapshot | null>(null);

/**
 * What a Blocked or Waiting badge counts from: the snapshot a mounted Dashboard holds, else the
 * copy stored on this device (`stored`, so the badge's popover says "as of"). It never subscribes,
 * so a badge adds no websocket traffic of its own.
 */
export function useBlockerSnapshot(environmentId: EnvironmentId | null): {
  readonly snapshot: DashboardSnapshot | null;
  readonly stored: boolean;
} {
  const mounted = useAtomValue(
    environmentId === null ? NO_BLOCKER_SNAPSHOT : mountedDashboardSnapshotAtom(environmentId),
  );
  const stored = useAtomValue(
    environmentId === null ? NO_BLOCKER_SNAPSHOT : storedDashboardSnapshot(environmentId),
  );
  return useMemo(
    () => (mounted ? { snapshot: mounted, stored: false } : { snapshot: stored, stored: true }),
    [mounted, stored],
  );
}
