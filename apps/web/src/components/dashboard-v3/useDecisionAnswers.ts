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
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  RuntimeRequestId,
  type DashboardAttention,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { newMessageId } from "../../lib/utils";
import { refreshDashboard } from "../../state/dashboard";
import { readThreadShells, useServerConfigs } from "../../state/entities";
import { decideProjectRequest } from "../../state/projectIssues";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSendToThread } from "../orchestrators/sendToOrchestrator";
import { useUndoableActions } from "../orchestrators/ProjectRequestsSection";
import { toastManager } from "../ui/toast";
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
  | { readonly ok: false; readonly error: string; readonly retry?: false };

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]): Result => {
  const error = squashAtomCommandFailure(result);
  return {
    ok: false,
    error: error instanceof Error && error.message ? error.message : "Could not reach the server.",
  };
};

/** The server's refusal when the item moved on after the card was drawn (`expectAnswer` differs). */
const STALE_CARD = /no longer waiting on you/i;

/** The decide-time mode of an issue card; a thread's own question or approval has none. */
const issueAnswerOf = (answer: DashboardAttention["answer"]) =>
  answer === undefined || answer === "thread-question" || answer === "thread-approval"
    ? undefined
    : answer;

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
  const sendToThread = useSendToThread();
  // A typed answer nobody sent yet, kept per card so a snapshot refresh does not drop it.
  const drafts = useRef(new Map<string, string>());
  const [records, setRecords] = useState<ReadonlyMap<string, AnswerRecord>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const openKeys = useRef<ReadonlySet<string>>(new Set());
  // False once the host unmounts: an answer still in flight then has no card to show its failure.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const live = timers.current;
    return () => {
      mounted.current = false;
      for (const timer of live.values()) clearTimeout(timer);
    };
  }, []);

  // The commands and the undo queue are new objects every render; the returned value reads them
  // through this ref so it only changes when a card's state does, not on every Dashboard render.
  const latest = useRef({ decide, respondToApproval, respondToUserInput, undoable, sendToThread });
  useEffect(() => {
    latest.current = { decide, respondToApproval, respondToUserInput, undoable, sendToThread };
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
          set(row.key, {
            row,
            label,
            delivery: { phase: "failed", error: result.error },
            retry: result.retry === false ? null : retry,
          });
          if (!mounted.current)
            toastManager.add({
              type: "error",
              title: `Not sent: ${row.attention.title}`,
              description: result.error,
            });
          return false;
        }
        // Only a delivered answer ends the draft; Undo and a failure leave it to be edited.
        for (const key of [...drafts.current.keys()])
          if (key === row.key || key.startsWith(`${row.key}|`)) drafts.current.delete(key);
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
        readonly reason?: string;
      },
    ) => {
      const task = parseIssueTaskId(row.attention.taskId);
      const root = row.scoped.project.rootThreadId;
      if (!task || !root) return;
      const expectAnswer = issueAnswerOf(row.attention.answer);
      perform(row, label, async () => {
        const result = await latest.current.decide({
          environmentId: row.scoped.environmentId,
          input: {
            threadId: root,
            reference: `${task.repository}#${task.number}`,
            // Brad's own click: the server lets only him close finished work.
            actor: "brad",
            ...(expectAnswer ? { expectAnswer } : {}),
            ...body,
          },
        });
        if (result._tag !== "Success") {
          const failed = failureText(result);
          if (!failed.ok && STALE_CARD.test(failed.error)) {
            // The item moved on while the card was open: say so and re-read, never resend it.
            refreshDashboard(row.scoped.environmentId);
            return {
              ok: false,
              error: "This item changed and no longer waits on you. The list was refreshed.",
              retry: false,
            };
          }
          return failed;
        }
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
      /**
       * One click on a listed option of an issue item; `action` says what the server does with it.
       * A typed `note` rides along as the reason (Passed or Failed plus what was seen), so a click
       * never drops what Brad wrote.
       */
      answerOption: (row: DecisionRow, option: PlanOption, note = "") => {
        const action = option.action;
        if (action === "follow-up") return;
        const decision = action === undefined || action === "option" ? "option" : action;
        const reason = sendableText(note);
        decideIssue(row, reason ? `${option.text} with your note` : option.text, {
          decision,
          ...(decision === "option" ? { option: option.text.slice(0, 300) } : {}),
          ...(reason ? { reason } : {}),
        });
      },
      /**
       * Typed words alone on an issue item: Brad's answer, recorded as written. The server never
       * reads it as Passed, Failed or Approve; the item keeps its stage.
       */
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
      /** Drops a failed answer so the card is open again, with its draft in the box. */
      dismiss: (key: string) => set(key, null),
      /**
       * Declines a thread's approval and tells the thread why. The decline goes first; the message
       * follows only once it landed, and a Retry after a failed message sends the message alone.
       */
      declineWithMessage: (row: DecisionRow, decision: ProviderApprovalDecision, text: string) => {
        const { threadId, requestId } = row.attention;
        const typed = sendableText(text);
        if (!threadId || !requestId || !typed) return;
        const message = `Declined: ${typed}`;
        const messageId = newMessageId();
        let declined = false;
        perform(row, message, async () => {
          if (!declined) {
            const result = await latest.current.respondToApproval({
              environmentId: row.scoped.environmentId,
              input: { threadId, requestId: RuntimeRequestId.make(requestId), decision },
            });
            if (result._tag !== "Success") return failureText(result);
            declined = true;
          }
          const shell = readThreadShells().find(
            (thread) => thread.environmentId === row.scoped.environmentId && thread.id === threadId,
          );
          if (!shell)
            return { ok: false, error: "Declined, but the thread was not found to tell it why." };
          const sent = await latest.current.sendToThread(
            { environmentId: row.scoped.environmentId, threadId },
            shell,
            message,
            [],
            { busy: threadRuntimeIsActive(shell.runtime), messageId },
          ).done;
          return sent.ok
            ? { ok: true, notified: true, landed: { threadId } }
            : { ok: false, error: `Declined, but the message was not sent: ${sent.reason}` };
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

/**
 * Who gets the answer, in words: the asking thread for a thread's own question, else the thread
 * the item names when the shells know it (the owner or the one waiting), else the project.
 */
export const toldOf = (row: DecisionRow): string => {
  if (row.attention.requestId !== null) return row.attention.title;
  const threadId = row.attention.threadId;
  const thread = threadId
    ? readThreadShells().find(
        (candidate) =>
          candidate.environmentId === row.scoped.environmentId && candidate.id === threadId,
      )
    : undefined;
  return thread?.title ?? row.scoped.project.title;
};
