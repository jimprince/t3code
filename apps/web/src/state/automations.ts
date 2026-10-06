import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** A project's automation rules; refreshed while an automations view is open. */
export const automationsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:automations:list",
  tag: WS_METHODS.automationsList,
  staleTimeMs: 15_000,
  refreshIntervalMs: 30_000,
  idleTtlMs: 0,
});

/** Newest runs first, with each step's thread. */
export const automationRunsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:automations:runs",
  tag: WS_METHODS.automationsRuns,
  staleTimeMs: 10_000,
  refreshIntervalMs: 15_000,
  idleTtlMs: 0,
});

export const saveAutomation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:save",
  tag: WS_METHODS.automationsSave,
});
export const removeAutomation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:remove",
  tag: WS_METHODS.automationsRemove,
});
export const setAutomationEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:set-enabled",
  tag: WS_METHODS.automationsSetEnabled,
});
export const runAutomation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:automations:run",
  tag: WS_METHODS.automationsRun,
});
