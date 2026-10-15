import {
  decisionReceipt,
  decisionSendStrip,
  type DecisionDelivery,
  type DecisionLanding,
} from "@t3tools/client-runtime/decision-answer";
import {
  answerPlan,
  questionAnswerValues,
  sendableText,
  type AnswerPlan,
  type PlanOption,
  type PlanQuestion,
} from "@t3tools/client-runtime/decision-card";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { RuntimeRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { decideProjectRequest } from "../../state/projectIssues";
import { useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUndoableActions } from "../orchestrators/ProjectRequestsSection";
import type { DecisionRow } from "./context";
import {
  ANSWER_CAP_MS,
  ANSWER_LINGER_MS,
  answerSettled,
  parseIssueTaskId,
} from "./dashboard.logic";

export interface AnswerRecord {
  readonly row: DecisionRow;
  /** What was picked, as the card shows it. */
  readonly label: string;
  readonly delivery: DecisionDelivery;
  readonly retry: (() => void) | null;
}

type Result =
  | { readonly ok: true; readonly notified: boolean; readonly landed?: DecisionLanding }
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
 * `respondToApproval`, a thread's question through `respondToUserInput` with its question ids, and
 * typed text on an issue through the same `decideProjectRequest` as an option (one comment, one
 * message, the same receipt). Every answer is held for a few seconds with Undo, then sent; the card shows
 * what happened until the snapshot drops it. A delivered answer stays answered while the snapshot
 * still lists the decision (it lags the answer), up to `ANSWER_CAP_MS`; `reconcile` reports which
 * decisions are still listed.
 */
export function useDecisionAnswers() {
  const decide = useAtomCommand(decideProjectRequest, "Decide");
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const undoable = useUndoableActions();
  // A typed answer nobody sent yet, kept per card so a snapshot refresh does not drop it.
  const drafts = useRef(new Map<string, string>());
  const [records, setRecords] = useState<ReadonlyMap<string, AnswerRecord>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const openKeys = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) clearTimeout(timer);
    };
  }, []);

  // The commands and the undo queue are new objects every render; the returned value reads them
  // through this ref so it only changes when a card's state does, not on every Dashboard render.
  const latest = useRef({ decide, respondToApproval, respondToUserInput, undoable });
  useEffect(() => {
    latest.current = { decide, respondToApproval, respondToUserInput, undoable };
  });
  const { queued } = undoable;

  return useMemo(() => {
    const set = (key: string, record: AnswerRecord | null) =>
      setRecords((current) => {
        const next = new Map(current);
        if (record) next.set(key, record);
        else next.delete(key);
        return next;
      });

    // Forgets delivered answers that are settled; hands back the same map when none are.
    const sweep = () =>
      setRecords((current) => {
        const now = Date.now();
        const kept = [...current].filter(
          ([key, { delivery }]) =>
            delivery.phase !== "sent" ||
            !answerSettled({ sentAt: delivery.at, stillOpen: openKeys.current.has(key), now }),
        );
        return kept.length === current.size ? current : new Map(kept);
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
          delivery: {
            phase: "sent",
            at: Date.now(),
            notified: result.notified,
            ...(result.landed ? { landed: result.landed } : {}),
          },
          retry: null,
        });
        for (const [suffix, delay] of [
          ["linger", ANSWER_LINGER_MS],
          ["cap", ANSWER_CAP_MS],
        ] as const) {
          clearTimeout(timers.current.get(`${row.key}|${suffix}`));
          timers.current.set(`${row.key}|${suffix}`, setTimeout(sweep, delay));
        }
        return true;
      };
      latest.current.undoable.run(row.key, label, execute);
    };

    const decideIssue = (
      row: DecisionRow,
      label: string,
      body: {
        readonly decision: "approve" | "reject" | "not-yet" | "option" | "answer";
        readonly option?: string;
        readonly answer?: string;
      },
    ) => {
      const task = parseIssueTaskId(row.attention.taskId);
      const root = row.scoped.project.rootThreadId;
      if (!task || !root) return;
      perform(row, label, async () => {
        const result = await latest.current.decide({
          environmentId: row.scoped.environmentId,
          input: { threadId: root, reference: `${task.repository}#${task.number}`, ...body },
        });
        if (result._tag !== "Success") return failureText(result);
        const { notifiedThreadId, commentUrl } = result.value;
        return {
          ok: true,
          notified: notifiedThreadId !== null,
          landed: {
            commentedOn: `#${task.number}`,
            commentUrl,
            threadId: notifiedThreadId ?? undefined,
          },
        };
      });
    };

    return {
      /** Reports the decisions the snapshot still lists, so answered ones can be forgotten once gone. */
      reconcile: (open: ReadonlySet<string>) => {
        openKeys.current = open;
        sweep();
      },
      /** The answer on a card, held (with Undo), sending, sent or failed; null while still open. */
      stateOf: (key: string) => {
        const held = queued.find((entry) => entry.key === key);
        if (held)
          return {
            kind: "held" as const,
            label: held.label,
            undo: () => latest.current.undoable.undo(key),
          };
        const record = records.get(key);
        return record ? { kind: "record" as const, record } : null;
      },
      /** Answers held or delivered whose decision is no longer in the feed, to keep their card up. */
      records,
      strip: (state: "held" | DecisionDelivery, waiting: string) =>
        decisionSendStrip(state, waiting),
      /** The confirmation line for a card: what was sent, where it landed, or what is about to go. */
      receipt: (label: string, state: "held" | DecisionDelivery, waiting: string) =>
        decisionReceipt(label, state, waiting),
      /** The typed answer nobody has sent yet on this card. */
      draftOf: (key: string) => drafts.current.get(key) ?? "",
      setDraft: (key: string, text: string) => {
        if (text) drafts.current.set(key, text);
        else drafts.current.delete(key);
      },
      /** One click on a listed option of an issue item; `action` says what the server does with it. */
      answerOption: (row: DecisionRow, option: PlanOption) => {
        const action = option.action;
        if (action === "follow-up") return;
        const decision = action === undefined || action === "option" ? "option" : action;
        decideIssue(row, option.text, {
          decision,
          ...(decision === "option" ? { option: option.text.slice(0, 300) } : {}),
        });
      },
      /** A typed answer on an issue item: the same decide call, trail and receipt as a click. */
      answerText: (row: DecisionRow, text: string) => {
        const answer = sendableText(text);
        if (answer) decideIssue(row, answer, { decision: "answer", answer });
      },
      /** A thread's question answered per question id through the existing respond path. */
      answerQuestions: (
        row: DecisionRow,
        questions: ReadonlyArray<PlanQuestion>,
        picks: Readonly<Record<string, string>>,
      ) => {
        const { threadId, requestId } = row.attention;
        const answers = questionAnswerValues(questions, picks);
        if (!threadId || !requestId || Object.keys(answers).length === 0) return;
        const values = Object.values(answers);
        const label = values.length === 1 ? values[0]! : `${values.length} answers`;
        perform(row, label, async () => {
          const result = await latest.current.respondToUserInput({
            environmentId: row.scoped.environmentId,
            input: { threadId, requestId: RuntimeRequestId.make(requestId), answers },
          });
          return result._tag === "Success"
            ? { ok: true, notified: true, landed: { threadId } }
            : failureText(result);
        });
      },
      /** Answers a running thread's approval request with one of its choices. */
      respond: (row: DecisionRow, decision: ProviderApprovalDecision, label: string) => {
        const { threadId, requestId } = row.attention;
        if (!threadId || !requestId) return;
        perform(row, label, async () => {
          const result = await latest.current.respondToApproval({
            environmentId: row.scoped.environmentId,
            input: { threadId, requestId: RuntimeRequestId.make(requestId), decision },
          });
          return result._tag === "Success"
            ? { ok: true, notified: true, landed: { threadId } }
            : failureText(result);
        });
      },
    };
  }, [queued, records]);
}

export type DecisionAnswers = ReturnType<typeof useDecisionAnswers>;

/**
 * What this card lets Brad do in place. Hosts that advertise `decisionAnswers` get the full answer
 * area; older ones keep the controls the card had before (option buttons on a needs-brad decision,
 * approve/decline on a live approval, otherwise Open).
 */
export function useAnswerPlan(row: DecisionRow): AnswerPlan {
  const configs = useServerConfigs();
  const decisionAnswers =
    configs.get(row.scoped.environmentId)?.environment.capabilities.decisionAnswers === true;
  return answerPlan(row.attention, {
    decisionAnswers,
    issueAnswerable:
      row.scoped.project.rootThreadId !== null && parseIssueTaskId(row.attention.taskId) !== null,
    told: toldOf(row),
  });
}

/** Who gets the answer, in words: the asking thread for a thread's own question, else the project. */
export const toldOf = (row: DecisionRow): string =>
  row.attention.requestId !== null ? row.attention.title : row.scoped.project.title;
