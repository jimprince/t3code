import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BlockerPermissions } from "@t3tools/client-runtime/dashboard/blockers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useServerConfigs, waitForThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { resolveThreadLinkTarget } from "../../state/threadLinks";
import { resumeThreadFromPlan } from "../../state/threadResume";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { resumeFailureText } from "../dashboard-v3/resumeFromPlan.logic";

/** What an explicit click did, kept in the popover until it closes or `RECEIPT_MS` passes. */
export interface BlockerReceipt {
  readonly key: string;
  readonly text: string;
  readonly failed: boolean;
  readonly undo?: () => void;
  readonly open?: () => void;
}

/** A receipt, and the Undo on it, is gone after this long even if the popover stays open. */
export const RECEIPT_MS = 60_000;

/** A thread and the environment that holds it; thread ids are only unique within one. */
export interface ThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : "Could not reach the server.";
};

/** What this connection may do to the blocked threads, as the blocker derivation takes it. */
export function useBlockerPermissions(
  environmentId: EnvironmentId,
): Omit<BlockerPermissions, "now"> {
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canSettle = capabilities?.threadSettlement === true;
  const canResumePlan = capabilities?.threadResumeFromPlan === true;
  return useMemo(
    () => ({ canOperate, canSettle, canResumePlan, canResumeQueue: true, environmentId }),
    [canOperate, canSettle, canResumePlan, environmentId],
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

/** The key a button's pending state is tracked under. */
export const pendingKey = (type: "queue" | "plan", target: ThreadTarget) =>
  `${type}:${target.environmentId}:${target.threadId}`;

/**
 * The state-changing buttons of a Blocked popover. Every one is an explicit click: it shows a
 * pending label, then leaves a receipt (with Undo for a settle, a way into the thread for a
 * resume). Nothing here runs on its own and nothing hides a row; the list changes when the next
 * push says so. The hook lives inside the popup, so closing it drops every receipt and Undo; a
 * receipt also expires after `RECEIPT_MS`. Each call names the environment of the thread it acts
 * on, since a remote worker can sit under a row of another environment.
 */
export function useBlockerActions() {
  const settle = useOrchestrationCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useOrchestrationCommand(threadEnvironment.unsettle, { reportFailure: false });
  const resumeQueue = useOrchestrationCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const resumePlan = useOrchestrationCommand(resumeThreadFromPlan, { reportFailure: false });
  const navigate = useNavigate();
  const openThreadIn = useOpenThread();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [receipts, setReceipts] = useState<ReadonlyArray<BlockerReceipt>>([]);
  // A ref, not `pending`: a second click in the same frame still sees the old state.
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    if (receipts.length === 0) return;
    const timer = setTimeout(() => setReceipts([]), RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [receipts]);

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

  // Undo restores exactly the threads this click settled. It unsettles with reason "user", which
  // pins a thread active so auto-settle does not take it straight back; a thread that was never
  // pinned before is therefore pinned after, an accepted difference from a perfect restore.
  const undoSettle = (targets: ReadonlyArray<ThreadTarget>) =>
    run("settle", async () => {
      const restored: ThreadTarget[] = [];
      for (const { environmentId, threadId } of targets) {
        const result = await unsettle({ environmentId, input: { threadId, reason: "user" } });
        if (result._tag !== "Success")
          return {
            key: "settle",
            text: `Restored ${restored.length} of ${targets.length}: ${failureText(result)}`,
            failed: true,
          };
        restored.push({ environmentId, threadId });
      }
      return { key: "settle", text: `Restored ${restored.length}`, failed: false };
    });

  const settleThreads = (targets: ReadonlyArray<ThreadTarget>) =>
    run("settle", async () => {
      const settled: ThreadTarget[] = [];
      for (const { environmentId, threadId } of targets) {
        const result = await settle({ environmentId, input: { threadId } });
        if (result._tag !== "Success")
          return {
            key: "settle",
            text: `Settled ${settled.length} of ${targets.length}: ${failureText(result)}`,
            failed: true,
            ...(settled.length > 0 ? { undo: () => void undoSettle(settled) } : {}),
          };
        settled.push({ environmentId, threadId });
      }
      return {
        key: "settle",
        text: `Settled ${settled.length}`,
        failed: false,
        undo: () => void undoSettle(settled),
      };
    });

  const resumeThreadQueue = (target: ThreadTarget) =>
    run(pendingKey("queue", target), async () => {
      const key = pendingKey("queue", target);
      const result = await resumeQueue({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      return result._tag === "Success"
        ? {
            key,
            text: "Queue resumed",
            failed: false,
            open: () => openThreadIn(target.environmentId, target.threadId),
          }
        : { key, text: failureText(result), failed: true };
    });

  const resumeFromPlan = (target: ThreadTarget) =>
    run(pendingKey("plan", target), async () => {
      const key = pendingKey("plan", target);
      const result = await resumePlan({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag !== "Success")
        return { key, text: resumeFailureText(squashAtomCommandFailure(result)), failed: true };
      const ref = scopeThreadRef(target.environmentId, result.value.newThreadId);
      return {
        key,
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

  return {
    pending,
    receipts,
    settleThreads,
    resumeThreadQueue,
    resumeFromPlan,
    openThread: openThreadIn,
  };
}

export type BlockerActions = ReturnType<typeof useBlockerActions>;
