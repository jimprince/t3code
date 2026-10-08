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

/** Opens (or reuses) a thread to talk a decision through before answering it. */
export const mobileDiscussProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:project-requests:discuss",
  tag: WS_METHODS.projectRequestsDiscuss,
});

/** What the project tree's threads are asking Brad, with the question and approval text. */
export const mobilePendingAsks = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:project-requests:pending-asks",
  tag: WS_METHODS.projectRequestsPendingAsks,
  staleTimeMs: 15_000,
  // Read afresh when a thread starts waiting again, as on web.
  idleTtlMs: 0,
});

/** Brad settles a card: closes its issue. */
export const mobileSettleProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:project-requests:settle",
  tag: WS_METHODS.projectRequestsSettle,
});

/** Brad approves a Review card: its pull request is merged and the issue settled. */
export const mobileApproveMergeProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:project-requests:approve-merge",
  tag: WS_METHODS.projectRequestsApproveMerge,
});

/** Brad sends a Review or Test card back with a note. */
export const mobileSendBackProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:project-requests:send-back",
  tag: WS_METHODS.projectRequestsSendBack,
});

/** Later for a card: hide it until a time, move it to the end, or bring it back. */
export const mobileDeferProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:project-requests:defer",
  tag: WS_METHODS.projectRequestsDefer,
});
