import {
  decisionAnswerInput,
  decisionSendStrip,
  type DecisionDelivery,
} from "@t3tools/client-runtime/decision-answer";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { RuntimeRequestId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { decideProjectRequest } from "../../state/projectIssues";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUndoableActions } from "../orchestrators/ProjectRequestsSection";
import type { DecisionRow } from "./context";
import { parseIssueTaskId } from "./dashboard.logic";

/** How long an answered card stays once the server has taken it, before the next snapshot drops it. */
const SENT_LINGER_MS = 6_000;

export interface AnswerRecord {
  readonly row: DecisionRow;
  /** What was picked, as the card shows it. */
  readonly label: string;
  readonly delivery: DecisionDelivery;
  readonly retry: (() => void) | null;
}

type Result =
  | { readonly ok: true; readonly notified: boolean }
  | { readonly ok: false; readonly error: string };

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]): Result => {
  const error = squashAtomCommandFailure(result);
  return {
    ok: false,
    error: error instanceof Error && error.message ? error.message : "Could not reach the server.",
  };
};

/**
 * Answers a Dashboard decision through the services the Decisions feed already uses: an option on a
 * decision issue goes through `decideProjectRequest`, an approval through the waiting thread's
 * `respondToApproval`. Every answer is held for a few seconds with Undo, then sent; the card shows
 * what happened until the snapshot drops it.
 */
export function useDecisionAnswers() {
  const decide = useAtomCommand(decideProjectRequest, "Decide");
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const undoable = useUndoableActions();
  const [records, setRecords] = useState<ReadonlyMap<string, AnswerRecord>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) clearTimeout(timer);
    };
  }, []);

  const set = (key: string, record: AnswerRecord | null) =>
    setRecords((current) => {
      const next = new Map(current);
      if (record) next.set(key, record);
      else next.delete(key);
      return next;
    });

  const perform = (row: DecisionRow, label: string, run: () => Promise<Result>) => {
    const execute = async (): Promise<boolean> => {
      const retry = () => void execute();
      set(row.key, { row, label, delivery: { phase: "sending" }, retry: null });
      const result = await run();
      if (!result.ok) {
        set(row.key, { row, label, delivery: { phase: "failed", error: result.error }, retry });
        return false;
      }
      set(row.key, {
        row,
        label,
        delivery: { phase: "sent", at: Date.now(), notified: result.notified },
        retry: null,
      });
      clearTimeout(timers.current.get(row.key));
      timers.current.set(
        row.key,
        setTimeout(() => set(row.key, null), SENT_LINGER_MS),
      );
      return true;
    };
    undoable.run(row.key, label, execute);
  };

  const environmentId = (row: DecisionRow) => row.scoped.environmentId;

  return {
    /** The answer on a card, held (with Undo), sending, sent or failed; null while still open. */
    stateOf: (key: string) => {
      const held = undoable.queued.find((entry) => entry.key === key);
      if (held) return { kind: "held" as const, label: held.label, undo: () => undoable.undo(key) };
      const record = records.get(key);
      return record ? { kind: "record" as const, record } : null;
    },
    /** Answers held or delivered whose decision is no longer in the feed, to keep their card up. */
    records,
    strip: (state: "held" | DecisionDelivery, waiting: string) => decisionSendStrip(state, waiting),
    /** Picks a listed option on a decision issue. */
    answerOption: (row: DecisionRow, option: string) => {
      const task = parseIssueTaskId(row.attention.taskId);
      const root = row.scoped.project.rootThreadId;
      const input = decisionAnswerInput({ kind: "option", option }, "");
      if (!task || !root || !input) return;
      perform(row, option, async () => {
        const result = await decide({
          environmentId: environmentId(row),
          input: {
            threadId: root,
            reference: `${task.repository}#${task.number}`,
            decision: input.decision,
            ...(input.option ? { option: input.option } : {}),
          },
        });
        return result._tag === "Success"
          ? { ok: true, notified: result.value.notifiedThreadId !== null }
          : failureText(result);
      });
    },
    /** Approves or declines a running thread's request. */
    respond: (row: DecisionRow, decision: "accept" | "decline", label: string) => {
      const { threadId, requestId } = row.attention;
      if (!threadId || !requestId) return;
      perform(row, label, async () => {
        const result = await respondToApproval({
          environmentId: environmentId(row),
          input: { threadId, requestId: RuntimeRequestId.make(requestId), decision },
        });
        return result._tag === "Success" ? { ok: true, notified: true } : failureText(result);
      });
    },
  };
}

export type DecisionAnswers = ReturnType<typeof useDecisionAnswers>;

/** Whether an answer in-place is possible for this decision, and how. */
export function answerMode(row: DecisionRow): "option" | "approval" | "open" {
  const { attention, scoped } = row;
  if (
    attention.requestId === null &&
    attention.kind === "decision" &&
    attention.options.length > 0 &&
    scoped.project.rootThreadId !== null &&
    parseIssueTaskId(attention.taskId)
  )
    return "option";
  if (
    attention.requestId !== null &&
    attention.kind === "approval" &&
    attention.canRespond &&
    attention.threadId !== null
  )
    return "approval";
  return "open";
}
