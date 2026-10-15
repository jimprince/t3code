import { useAtomValue } from "@effect/atom-react";
import {
  liveRuntimeRequests,
  type LiveRuntimeRequests,
} from "@t3tools/client-runtime/dashboard/live";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironments } from "./environments";
import { environmentSnapshotAtom } from "./shell";

/**
 * The live threads that have a pending runtime request, per connected environment, as one string, so a
 * subscriber re-renders only when a request appears or resolves, not on each of the shell updates
 * a running agent makes. Keyed by the sorted environment ids, like the Dashboard's own snapshots.
 */
const liveRuntimeRequestsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const live = liveRuntimeRequests(
      key
        .split(",")
        .filter(Boolean)
        .map((environmentId) => ({
          environmentId,
          threads: get(environmentSnapshotAtom(environmentId as EnvironmentId))?.threads ?? null,
        })),
    );
    return JSON.stringify({ environments: [...live.environments], threads: [...live.threads] });
  }).pipe(Atom.setIdleTTL(0)),
);

/**
 * What each environment's thread shells say is still pending. The Dashboard drops a snapshot ask
 * the thread no longer lists, since the snapshot can lag the answer by minutes (#303).
 */
export function useLiveRuntimeRequests(): LiveRuntimeRequests {
  const { environments } = useEnvironments();
  const ids = useMemo(
    () =>
      environments
        .map((environment) => environment.environmentId)
        .toSorted()
        .join(","),
    [environments],
  );
  const key = useAtomValue(liveRuntimeRequestsAtom(ids));
  return useMemo(() => {
    const parsed = JSON.parse(key) as { environments: string[]; threads: string[] };
    return { environments: new Set(parsed.environments), threads: new Set(parsed.threads) };
  }, [key]);
}
