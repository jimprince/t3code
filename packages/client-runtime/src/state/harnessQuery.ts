import type { HarnessSnapshot } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** @public Shared Harness query for the client UI; callers own mounted refreshes. */
export function createHarnessQuery<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "harness",
    tag: "harness.snapshot",
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
