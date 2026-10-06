import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

/** Read-only automation rules and their recent runs for the project overview. */
export const projectAutomations = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:project:automations",
    tag: WS_METHODS.automationsList,
    staleTimeMs: 30_000,
  }),
  runs: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:project:automation-runs",
    tag: WS_METHODS.automationsRuns,
    staleTimeMs: 30_000,
  }),
};
