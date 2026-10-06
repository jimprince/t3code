import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** A project tree's Gitea issues and requests, read-only on mobile. */
export const mobileProjectIssues = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:project-issues:list",
  tag: WS_METHODS.projectIssuesList,
  staleTimeMs: 60_000,
});

/** Brad answers a decision waiting on him; the one write mobile makes to the ledger. */
export const mobileDecideProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:project-requests:decide",
  tag: WS_METHODS.projectRequestsDecide,
});
