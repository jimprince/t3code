import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BlockerPermissions } from "@t3tools/client-runtime/dashboard/blockers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import { useServerConfigs, waitForThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { resolveThreadLinkTarget } from "../../state/threadLinks";
import { resumeThreadFromPlan } from "../../state/threadResume";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { resumeFailureText } from "../dashboard-v3/resumeFromPlan.logic";

/** What an explicit click did, kept in the popover until it closes. */
export interface BlockerReceipt {
  readonly key: string;
  readonly text: string;
  readonly failed: boolean;
  readonly undo?: () => void;
  readonly open?: () => void;
}

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : "Could not reach the server.";
};

/** What this connection may do to the blocked threads, as `threadBlockers` takes it. */
export function useBlockerPermissions(
  environmentId: EnvironmentId,
): Omit<BlockerPermissions, "now"> {
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canSettle = capabilities?.threadSettlement === true;
  const canResumePlan = capabilities?.threadResumeFromPlan === true;
  return useMemo(
    () => ({ canOperate, canSettle, canResumePlan, canResumeQueue: true }),
    [canOperate, canSettle, canResumePlan],
  );
}

/** Opens a thread in the environment that holds it. */
export function useOpenThread() {
  const navigate = useNavigate();
  return (environmentId: EnvironmentId, threadId: ThreadId) => {
    const target = resolveThreadLinkTarget(environmentId, threadId);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
    });
  };
}

/**
 * The state-changing buttons of a Blocked popover. Every one is an explicit click: it shows a
 * pending label, then leaves a receipt (with Undo for a settle, a way into the thread for a
 * resume) that stays until the host closes. Nothing here runs on its own and nothing hides a row;
 * the list changes when the next push says so.
 */
export function useBlockerActions(environmentId: EnvironmentId) {
  const settle = useOrchestrationCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useOrchestrationCommand(threadEnvironment.unsettle, { reportFailure: false });
  const resumeQueue = useOrchestrationCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const resumePlan = useOrchestrationCommand(resumeThreadFromPlan, { reportFailure: false });
  const navigate = useNavigate();
  const openThreadIn = useOpenThread();
  const openThread = (threadId: ThreadId) => openThreadIn(environmentId, threadId);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [receipts, setReceipts] = useState<ReadonlyArray<BlockerReceipt>>([]);
  // A ref, not `pending`: a second click in the same frame still sees the old state.
  const inFlight = useRef(new Set<string>());

  const run = async (key: string, work: () => Promise<BlockerReceipt>) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setPending((current) => new Set(current).add(key));
    try {
      const receipt = await work();
      setReceipts((current) => [...current.filter((entry) => entry.key !== key), receipt]);
    } finally {
      inFlight.current.delete(key);
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const undoSettle = (threadIds: ReadonlyArray<ThreadId>) =>
    run("settle", async () => {
      const restored: ThreadId[] = [];
      for (const threadId of threadIds) {
        // reason "user" pins the thread active, so auto-settle does not take it straight back.
        const result = await unsettle({ environmentId, input: { threadId, reason: "user" } });
        if (result._tag !== "Success")
          return {
            key: "settle",
            text: `Restored ${restored.length} of ${threadIds.length}: ${failureText(result)}`,
            failed: true,
          };
        restored.push(threadId);
      }
      return { key: "settle", text: `Restored ${restored.length}`, failed: false };
    });

  const settleThreads = (threadIds: ReadonlyArray<ThreadId>) =>
    run("settle", async () => {
      const settled: ThreadId[] = [];
      for (const threadId of threadIds) {
        const result = await settle({ environmentId, input: { threadId } });
        if (result._tag !== "Success")
          return {
            key: "settle",
            text: `Settled ${settled.length} of ${threadIds.length}: ${failureText(result)}`,
            failed: true,
            ...(settled.length > 0 ? { undo: () => void undoSettle(settled) } : {}),
          };
        settled.push(threadId);
      }
      return {
        key: "settle",
        text: `Settled ${settled.length}`,
        failed: false,
        undo: () => void undoSettle(settled),
      };
    });

  const resumeThreadQueue = (threadId: ThreadId) =>
    run(`queue:${threadId}`, async () => {
      const result = await resumeQueue({ environmentId, input: { threadId } });
      return result._tag === "Success"
        ? {
            key: `queue:${threadId}`,
            text: "Queue resumed",
            failed: false,
            open: () => openThread(threadId),
          }
        : { key: `queue:${threadId}`, text: failureText(result), failed: true };
    });

  const resumeFromPlan = (threadId: ThreadId) =>
    run(`plan:${threadId}`, async () => {
      const result = await resumePlan({ environmentId, input: { threadId } });
      if (result._tag !== "Success")
        return {
          key: `plan:${threadId}`,
          text: resumeFailureText(squashAtomCommandFailure(result)),
          failed: true,
        };
      const ref = scopeThreadRef(environmentId, result.value.newThreadId);
      return {
        key: `plan:${threadId}`,
        text: "Resumed in a new thread",
        failed: false,
        // The route treats a thread whose shell has not arrived as missing and leaves it.
        open: () =>
          void waitForThreadShell(ref).then((arrived) => {
            if (arrived)
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(ref),
              });
          }),
      };
    });

  return { pending, receipts, settleThreads, resumeThreadQueue, resumeFromPlan, openThread };
}

export type BlockerActions = ReturnType<typeof useBlockerActions>;
