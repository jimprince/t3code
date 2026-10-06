import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  supervisionForest,
  supervisionWorkerLines,
  supervisionKey,
  supervisionThreadKey,
} from "./forkNesting.ts";
import { createEnvironmentRpcQueryAtomFamily, followStreamInEnvironment } from "./runtime.ts";

export function supervisionMetadataReady<A, E>(
  connected: boolean,
  result: AsyncResult.AsyncResult<A, E>,
) {
  // A failed refresh keeps the last good metadata (`AsyncResult.value` reads it), so one dropped
  // request does not empty a host's tree; a host that never loaded stays not ready.
  return connected && Option.isSome(AsyncResult.value(result)) && !result.waiting;
}

/**
 * Sidecar nesting changes when a thread appears or disappears, or when a
 * nesting write lands on it (the CLI, agents and other devices write the
 * sidecar too; the server then bumps `forkMetadataRevision` through a native
 * shell update). The key is therefore the host's ids with their revisions,
 * which stays equal across status, approval and timestamp churn.
 */
export function createHostThreadIdsKey(shells: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      [
        ...get(shells)
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => `${thread.id}:${thread.forkMetadataRevision ?? 0}`),
      ]
        .sort()
        .join("\n"),
    ),
  );
}

/** One sidecar query per host, refreshed by native shell updates and reconnects. */
export function createSupervisionAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shells: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>,
) {
  const hostThreadIds = createHostThreadIdsKey(shells);
  const query = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "fork-supervision",
    tag: "fork.threads.metadata.list",
    refreshTrigger: ({ environmentId }) => hostThreadIds(environmentId),
  });
  const connected = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.state).pipe(
                Stream.map((state) => state.phase === "connected"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const readyHosts = Atom.make(
    (get) =>
      new Set(
        [...new Set(get(shells).map((thread) => thread.environmentId))].filter((environmentId) => {
          const state = get(connected(environmentId));
          const result = get(query({ environmentId, input: {} }));
          return supervisionMetadataReady(AsyncResult.isSuccess(state) && state.value, result);
        }),
      ),
  );
  const joinedShells = Atom.make((get) => {
    const ready = get(readyHosts);
    const modes = new Map(
      get(metadata).map((row) => [
        supervisionKey(row.environmentId, row.threadId),
        row.subproject ?? "auto",
      ]),
    );
    return get(shells).map((thread) => ({
      ...thread,
      forkMetadataAvailable: ready.has(thread.environmentId),
      subproject: modes.get(supervisionThreadKey(thread)) ?? "auto",
    }));
  });
  const metadata = Atom.make((get) => {
    const environments = new Set(get(shells).map((thread) => thread.environmentId));
    return [...environments].flatMap((environmentId) => {
      const result = get(query({ environmentId, input: {} }));
      return Option.match(AsyncResult.value(result), {
        onNone: () => [],
        onSome: (rows) => rows.map((row) => ({ ...row, environmentId })),
      });
    });
  });
  const forest = Atom.make((get) => supervisionForest(get(joinedShells), get(metadata)));
  const workerLines = Atom.family((threadKey: string) =>
    Atom.make((get) => supervisionWorkerLines(get(forest), threadKey)),
  );
  return { query, metadata, forest, readyHosts, workerLines };
}
