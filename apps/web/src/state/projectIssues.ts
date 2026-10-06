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

/** Brad settles a request: the server closes its issue. */
export const settleProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:settle",
  tag: WS_METHODS.projectRequestsSettle,
});

/** The New request box marks its message as an explicit request before sending it. */
export const submitProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:submit",
  tag: WS_METHODS.projectRequestsSubmit,
});
