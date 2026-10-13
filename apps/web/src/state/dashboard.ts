import { useAtomValue } from "@effect/atom-react";
import {
  createDashboardAtoms,
  createDashboardSnapshotMerger,
} from "@t3tools/client-runtime/dashboard";
import { DashboardSnapshot, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo } from "react";

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
  readonly revision: string;
  readonly snapshotSource: "cached" | "live" | "empty";
  readonly olderEnvironments: ReadonlyArray<string>;
  /** Re-opens every environment's subscription; the last good snapshot stays on screen meanwhile. */
  readonly retry: () => void;
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
  const retry = useCallback(() => {
    for (const { environmentId } of entries) dashboard.retry(appAtomRegistry, environmentId);
  }, [entries]);
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
      olderEnvironments: entries
        .filter((e) => e.state.olderServer)
        .map(
          (e) =>
            environments.find((env) => env.environmentId === e.environmentId)?.label ??
            e.environmentId,
        ),
      failed: entries.some(({ state }) => state.failed),
      retry,
    };
  }, [entries, environments, retry]);
}
