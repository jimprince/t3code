import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { supervisionForest } from "./forkNesting.ts";
import { createEnvironmentRpcQueryAtomFamily, followStreamInEnvironment } from "./runtime.ts";

/** One sidecar query per host, refreshed by native shell updates and reconnects. */
export function createSupervisionAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shells: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>,
) {
  const hostShells = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(shells).filter((thread) => thread.environmentId === environmentId)),
  );
  const query = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "fork-supervision",
    tag: "fork.threads.metadata.list",
    refreshTrigger: ({ environmentId }) => hostShells(environmentId),
  });
  const connected = Atom.family((environmentId: EnvironmentId) => runtime.atom(
    followStreamInEnvironment(environmentId, Stream.unwrap(EnvironmentSupervisor.EnvironmentSupervisor.pipe(
      Effect.map(supervisor => SubscriptionRef.changes(supervisor.state).pipe(Stream.map(state => state.phase === "connected"))),
    ))),
  ));
  const readyHosts = Atom.make(get => new Set(get(shells).map(thread => thread.environmentId).filter(environmentId => {
    const state = get(connected(environmentId));
    const result = get(query({environmentId, input: {}}));
    return AsyncResult.isSuccess(state) && state.value && AsyncResult.isSuccess(result) && !result.waiting;
  })));
  const joinedShells = Atom.make(get => {
    const ready = get(readyHosts);
    return get(shells).map(thread => ({...thread, forkMetadataAvailable: ready.has(thread.environmentId)}));
  });
  const metadata = Atom.make((get) => {
    const environments = new Set(get(shells).map((thread) => thread.environmentId));
    return [...environments].flatMap((environmentId) => {
      const result = get(query({ environmentId, input: {} }));
      return AsyncResult.isSuccess(result)
        ? result.value.map((row) => ({ ...row, environmentId }))
        : [];
    });
  });
  const forest = Atom.make((get) => supervisionForest(get(joinedShells), get(metadata)));
  return { query, metadata, forest, readyHosts };
}
