import type { HarnessSnapshot } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Environment routing is shared by web, desktop and mobile; callers own mounted refreshes. */
export function createHarnessQuery<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "harness",
    tag: "harness.snapshot",
  });
}
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
