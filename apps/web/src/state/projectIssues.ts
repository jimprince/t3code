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

/** Opens (or reuses) a thread to talk a decision through before answering it. */
export const discussProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:discuss",
  tag: WS_METHODS.projectRequestsDiscuss,
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

/** What the project tree's threads are asking Brad, with the question and approval text, for the Decisions feed. */
export const projectPendingAsksQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-requests:pending-asks",
  tag: WS_METHODS.projectRequestsPendingAsks,
  staleTimeMs: 15_000,
  idleTtlMs: 0,
});

/** Brad approves a Review card: its pull request is merged and the issue settled. */
export const approveMergeProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:approve-merge",
  tag: WS_METHODS.projectRequestsApproveMerge,
});

/** Brad sends a Review or Test card back with a note. */
export const sendBackProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:send-back",
  tag: WS_METHODS.projectRequestsSendBack,
});

/** Later for a card: hide it until a time, move it to the end, or bring it back. */
export const deferProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:defer",
  tag: WS_METHODS.projectRequestsDefer,
});

/**
 * Order, retype, re-parent and file calls for one project run one at a time: each reads fresh
 * tracker data on the server, so two in flight from this client would only race each other.
 */
const requestWrites = {
  mode: "serial",
  key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
    `project-requests:${environmentId}:${input.threadId}`,
} as const;

/** The Dashboard ranks a list's unranked rows in one write, so a first move is not one write per row. */
export const orderBatchProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:order-batch",
  tag: WS_METHODS.projectRequestsOrderBatch,
  concurrency: requestWrites,
});

/** Brad withdraws a filing made by mistake: closed with a label and a note to the owner. */
export const withdrawProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:withdraw",
  tag: WS_METHODS.projectRequestsWithdraw,
  concurrency: requestWrites,
});

/** The Dashboard asks the server to place an item in its order (top, bottom, before, after, none). */
export const orderProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:order",
  tag: WS_METHODS.projectRequestsOrder,
  concurrency: requestWrites,
});

/** Retypes, re-parents or closes a duplicate of an item (Brad's Dashboard actions). */
export const updateProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:update",
  tag: WS_METHODS.projectRequestsUpdate,
  concurrency: requestWrites,
});

/** The Dashboard request line files a typed item directly in the tracker, placed or not. */
export const fileProjectRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-requests:file",
  tag: WS_METHODS.projectRequestsCreate,
  concurrency: requestWrites,
});
