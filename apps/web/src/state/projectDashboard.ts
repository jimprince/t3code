import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** A project's Gitea tracker repository (the widget order lives in the project layout). */
export const projectDashboardQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-dashboard:get",
  tag: WS_METHODS.projectDashboardGet,
  staleTimeMs: 30_000,
  idleTtlMs: 0,
});

export const setProjectDashboardTracker = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-dashboard:set-tracker",
  tag: WS_METHODS.projectDashboardSetTracker,
});
