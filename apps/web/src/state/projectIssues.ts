import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** A project tree's Gitea issues, refreshed every minute while the project page is open. */
export const projectIssuesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-issues:list",
  tag: WS_METHODS.projectIssuesList,
  staleTimeMs: 30_000,
  refreshIntervalMs: 60_000,
  idleTtlMs: 0,
});

/** One task opened in the app: its body, recent comments and children, read when its panel opens. */
export const projectIssueQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-issues:get",
  tag: WS_METHODS.projectIssuesGet,
  staleTimeMs: 15_000,
  idleTtlMs: 0,
});

/** Brad settles a request: the server closes its issue. */
export const settleProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:settle",
  tag: WS_METHODS.projectRequestsSettle,
});

/** Brad approves, defers or picks an option for an item waiting on him in Needs you. */
export const decideProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:decide",
  tag: WS_METHODS.projectRequestsDecide,
});

/** The New request box marks its message as an explicit request before sending it. */
export const submitProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:submit",
  tag: WS_METHODS.projectRequestsSubmit,
});

/** The New request box starts a short-lived intake thread to triage the request. */
export const startRequestIntake = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:start-intake",
  tag: WS_METHODS.projectRequestsStartIntake,
});
