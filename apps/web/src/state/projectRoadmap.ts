import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The project roadmap: open milestones (versions) on the tracker and the items in them. */
export const projectRoadmapQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-roadmap:get",
  tag: WS_METHODS.projectRoadmapGet,
  staleTimeMs: 30_000,
  refreshIntervalMs: 60_000,
  idleTtlMs: 0,
});

export const moveRoadmapItem = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-roadmap:move",
  tag: WS_METHODS.projectRoadmapMove,
});

export const saveRoadmapVersion = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-roadmap:save-version",
  tag: WS_METHODS.projectRoadmapSaveVersion,
});

/** Files an idea as a request without sending it to the orchestrator: it lands in Later. */
export const saveRequestForLater = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:create",
  tag: WS_METHODS.projectRequestsCreate,
});
