import {
  WS_METHODS,
  type DashboardSnapshot,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "../state/runtime.ts";

/** Construct once beside the application's connection runtime; retained across route unmounts. */
export function createDashboardAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const subscription = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "dashboard:subscription",
    tag: WS_METHODS.subscribeDashboard,
    idleTtlMs: Infinity,
  });
  const cache = new Map<EnvironmentId, DashboardSnapshot>();
  const snapshot = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(subscription({ environmentId, input: {} }));
      const value = Option.getOrNull(AsyncResult.value(result));
      if (
        value &&
        (!cache.has(environmentId) || value.revision !== cache.get(environmentId)?.revision)
      )
        cache.set(environmentId, value);
      return {
        snapshot: cache.get(environmentId) ?? null,
        refreshing: result.waiting,
        failed: AsyncResult.isFailure(result),
      };
    }).pipe(Atom.keepAlive, Atom.withLabel(`dashboard:${environmentId}`)),
  );
  const scoped = Atom.family((encoded: string) => {
    const [environmentId, rootThreadId] = encoded.split("\0") as [EnvironmentId, ThreadId];
    return Atom.make((get) => {
      const state = get(snapshot(environmentId));
      const all = state.snapshot?.projects ?? [];
      const selected = new Set(all.filter((p) => p.rootThreadId === rootThreadId).map((p) => p.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of all)
          if (p.parentId && selected.has(p.parentId) && !selected.has(p.id)) {
            selected.add(p.id);
            changed = true;
          }
      }
      return { ...state, projects: all.filter((p) => selected.has(p.id)) };
    });
  });
  const project = (key: {
    readonly environmentId: EnvironmentId;
    readonly rootThreadId: ThreadId;
  }) => scoped(`${key.environmentId}\0${key.rootThreadId}`);
  return { snapshot, project };
}
