import { decisionVisibility } from "@t3tools/client-runtime/decision-deferral";
import {
  asksWithFallbacks,
  buildDecisionFeed,
  reviewPullRequest,
  type DecisionFeed,
  type DecisionFeedCard,
  type FeedItemInput,
  type FeedPlanInput,
} from "@t3tools/client-runtime/decision-feed";
import {
  keptOutcomes,
  nextOutcomeExpiry,
  type FeedDelivery,
} from "@t3tools/client-runtime/decision-outcome";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectIssue } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  approveMergeProjectRequest,
  deferProjectRequest,
  projectPendingAsksQuery,
  sendBackProjectRequest,
} from "../../state/projectIssues";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  DecisionFeedCardView,
  LaterControl,
  type FeedCardActions,
  type FeedOutcome,
} from "./DecisionFeedCards";
import { deriveDecisions } from "./decisions.logic";
import {
  issueKey,
  needsYouDecision,
  type NeedsYouDecision,
  type NeedsYouItem,
} from "./projectRequests.logic";
import { ProjectSection } from "./ProjectSection";
import {
  useDecide,
  useDiscuss,
  useNeedsYou,
  useOpenThread,
  useSettle,
  useUndoableActions,
} from "./ProjectRequestsSection";

type Result =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

const failure = (result: AtomCommandResult<unknown, unknown>): Result => {
  const error = squashAtomCommandFailure(result as never);
  return {
    ok: false,
    error: error instanceof Error && error.message ? error.message : "Could not reach the server.",
  };
};

/**
 * Everything waiting on Brad as one feed: the project's threads' questions, approvals and
 * plans, its decisions, and the answers, approvals, reviews and tests that used to be Needs
 * you. The same data feeds the widget and the "N need you" count in the status line.
 */
function useDecisionFeedData(
  summary: OrchestratorSummary,
  project: string | null,
  /** Only the widget re-reads the asks when the waiting set changes; the count shares its read. */
  refreshOnChange = false,
) {
  const environmentId = summary.root.environmentId;
  const { items: needsYou, query } = useNeedsYou(summary);
  const waiting = useMemo(
    () => summary.needsYou.filter((item) => item.kind === "approval" || item.kind === "input"),
    [summary.needsYou],
  );
  // The text of what threads ask is read once something waits, and again when that changes.
  const signature = waiting
    .map((item) => `${item.kind}:${item.thread.id}`)
    .toSorted()
    .join(",");
  const asksQuery = useEnvironmentQuery(
    signature
      ? projectPendingAsksQuery({ environmentId, input: { threadId: summary.root.id } })
      : null,
  );
  const refreshAsks = asksQuery.refresh;
  // The query reads on mount; a later change to who is waiting reads again.
  const seenSignature = useRef(signature);
  useEffect(() => {
    const previous = seenSignature.current;
    seenSignature.current = signature;
    // The first waiting thread switches the query on, which reads by itself.
    if (previous === signature || previous === "") return;
    if (refreshOnChange && signature) refreshAsks();
  }, [signature, refreshAsks, refreshOnChange]);

  const now = query.dataUpdatedAt ?? 0;
  const projectTitles = useMemo(
    () => new Map(summary.projects.map((entry) => [entry.id as string, entry.title])),
    [summary.projects],
  );
  const feed = useMemo<DecisionFeed>(() => {
    const titleOf = (projectId: string) => projectTitles.get(projectId) ?? "";
    // A thread that waits but whose text did not arrive still gets a card: nothing is lost.
    const asks = asksWithFallbacks({
      returned: asksQuery.data?.asks ?? [],
      loading: asksQuery.isPending && asksQuery.data === null,
      waiting: waiting.map((item) => ({
        kind: item.kind === "approval" ? "approval" : "input",
        threadId: item.thread.id,
        title: item.thread.title,
        projectTitle: titleOf(item.thread.projectId),
        updatedAt: item.thread.updatedAt,
      })),
    });
    const plans: FeedPlanInput[] = summary.needsYou
      .filter((item) => item.kind === "plan")
      .map((item) => ({
        threadId: item.thread.id,
        title: item.thread.title,
        projectTitle: titleOf(item.thread.projectId),
        since: item.thread.updatedAt,
      }));
    // An approve item with no ready comment to approve has nothing to approve: it is an answer to read.
    const items: FeedItemInput[] = needsYou.map((item) => ({
      issue: item.issue,
      group: item.group === "approve" && needsYouDecision(item) === null ? "answers" : item.group,
      testStep: item.request?.testStep ?? null,
    }));
    return buildDecisionFeed({
      asks,
      plans,
      decisions: deriveDecisions(query.data?.issues ?? []),
      items,
      now,
      project,
    });
  }, [
    asksQuery.data,
    asksQuery.isPending,
    needsYou,
    now,
    project,
    projectTitles,
    query.data,
    summary.needsYou,
    waiting,
  ]);

  const byKey = useMemo(
    () => new Map<string, NeedsYouItem>(needsYou.map((item) => [issueKey(item.issue), item])),
    [needsYou],
  );
  // A sent card may leave once both reads (issues and thread asks) happened after it was sent.
  const readAt = asksQuery.data === null ? now : Math.min(now, asksQuery.dataUpdatedAt ?? now);
  return {
    feed,
    now,
    readAt,
    query,
    byKey,
    refreshAll: () => {
      query.refresh();
      refreshAsks();
    },
  };
}

/** "N need you" in the status line: every visible card of the feed. */
export function useDecisionFeedCount(summary: OrchestratorSummary): number {
  return useDecisionFeedData(summary, null).feed.total;
}

interface OutcomeRecord {
  readonly card: DecisionFeedCard;
  /** Where the card stood in the feed, so it stays put while it shows its outcome. */
  readonly index: number;
  readonly label: string;
  readonly delivery: FeedDelivery;
  readonly undo: (() => void) | null;
  readonly retry: (() => void) | null;
}

const returnTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * The Decisions feed: one list for everything that needs Brad. Blocked threads first, then
 * newest first; project chips narrow it; Later hides a card until a time or moves it to the
 * end. Acting on a card keeps it on screen showing what happened until it leaves.
 */
export function ProjectDecisionFeed({ summary }: { readonly summary: OrchestratorSummary }) {
  const environmentId = summary.root.environmentId;
  const [project, setProject] = useState<string | null>(null);
  const [showLater, setShowLater] = useState(false);
  const { feed, now, readAt, byKey, refreshAll } = useDecisionFeedData(summary, project, true);
  const undoable = useUndoableActions();
  const decide = useDecide(summary, refreshAll);
  const discuss = useDiscuss(summary);
  const settle = useSettle(summary, refreshAll);
  const openThread = useOpenThread(summary);
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const approveMerge = useAtomCommand(approveMergeProjectRequest, "Approve and merge");
  const sendBack = useAtomCommand(sendBackProjectRequest, "Send back");
  const defer = useAtomCommand(deferProjectRequest, "Later");

  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, OutcomeRecord>>(new Map());
  const liveKeys = useMemo(() => new Set(feed.cards.map((card) => card.key)), [feed.cards]);
  // A sent card leaves once a list read after it no longer has it and it has been on screen
  // long enough to read; a timer re-checks when the earliest one is due.
  const [clock, setClock] = useState(0);
  const kept = keptOutcomes(outcomes, liveKeys, readAt, clock);
  useEffect(() => {
    setOutcomes((current) => keptOutcomes(current, liveKeys, readAt, clock));
  }, [liveKeys, readAt, clock]);
  useEffect(() => {
    const next = nextOutcomeExpiry(outcomes, clock);
    if (next === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [outcomes, clock]);
  const record = (key: string, entry: OutcomeRecord | null) =>
    setOutcomes((current) => {
      const next = new Map(current);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });

  const indexOf = (card: DecisionFeedCard) =>
    Math.max(
      0,
      feed.cards.findIndex((candidate) => candidate.key === card.key),
    );

  /** Runs an action on a card, optionally after an Undo hold, and keeps its outcome on the card. */
  const perform = (
    card: DecisionFeedCard,
    label: string,
    options: { readonly hold: boolean; readonly undo?: () => Promise<unknown> },
    run: () => Promise<Result>,
  ) => {
    const key = card.key;
    const index = indexOf(card);
    const execute = async (): Promise<boolean> => {
      const base = { card, index, label };
      const retry = () => void execute();
      record(key, { ...base, delivery: { phase: "sending" }, undo: null, retry: null });
      const result = await run();
      record(key, {
        ...base,
        delivery: result.ok
          ? { phase: "sent", at: Date.now(), text: result.text }
          : { phase: "failed", error: result.error },
        undo:
          result.ok && options.undo
            ? () =>
                void options.undo!().then(() => {
                  record(key, null);
                  refreshAll();
                })
            : null,
        retry: result.ok ? null : retry,
      });
      refreshAll();
      return true;
    };
    if (options.hold) undoable.run(key, label, execute);
    else void execute();
  };

  const whoIsTold = (card: DecisionFeedCard) =>
    card.blocked
      ? card.kind === "plan"
        ? card.plan.title
        : card.ask.threadTitle
      : (card.issue.owner?.title ?? "the project orchestrator");

  const actions: FeedCardActions = {
    openThread,
    discuss: (issue) => void discuss.start(issue),
    discussing: discuss.pending,
    answerQuestion: (card, ask, answers, label) =>
      perform(card, label, { hold: true }, async () => {
        const result = await respondToUserInput({
          environmentId,
          input: { threadId: ask.threadId, requestId: ask.requestId, answers },
        });
        return result._tag === "Success"
          ? { ok: true, text: `Sent to ${ask.threadTitle}` }
          : failure(result);
      }),
    respondApproval: (card, ask, decision, label) =>
      perform(card, label, { hold: false }, async () => {
        const result = await respondToApproval({
          environmentId,
          input: { threadId: ask.threadId, requestId: ask.requestId, decision },
        });
        return result._tag === "Success"
          ? { ok: true, text: `Sent to ${ask.threadTitle}` }
          : failure(result);
      }),
    decideIssue: (card, kind, extra, label) => {
      if (card.blocked) return;
      const told = whoIsTold(card);
      perform(card, label, { hold: true }, async () => {
        const outcome = await decide(card.issue, kind, extra);
        return outcome.sent
          ? {
              ok: true,
              text: outcome.notified
                ? `Sent to ${told}`
                : `Posted on the issue; ${told} was not found`,
            }
          : { ok: false, error: outcome.error };
      });
    },
    settle: (card, label) => {
      if (card.blocked) return;
      const { issue } = card;
      perform(card, label, { hold: true, undo: () => settle.reopen(issue) }, async () => {
        const error = await settle.settle([issue]);
        return error === null
          ? { ok: true, text: `Settled #${issue.number}` }
          : { ok: false, error };
      });
    },
    approveMerge: (card, pr) => {
      if (card.blocked) return;
      const { issue } = card;
      perform(card, "Approve and merge", { hold: false }, async () => {
        const result = await approveMerge({
          environmentId,
          input: {
            threadId: summary.root.id,
            reference: issueKey(issue),
            ...(pr ? { pullRequest: pr.number } : {}),
            ...(pr?.headSha ? { headSha: pr.headSha } : {}),
          },
        });
        return result._tag === "Success"
          ? {
              ok: true,
              text: `Merged PR ${result.value.pullRequest.number} and settled #${issue.number}`,
            }
          : failure(result);
      });
    },
    sendBack: (card, note, label) => {
      if (card.blocked) return;
      const { issue } = card;
      perform(card, label, { hold: false }, async () => {
        const result = await sendBack({
          environmentId,
          input: { threadId: summary.root.id, reference: issueKey(issue), note },
        });
        return result._tag === "Success"
          ? {
              ok: true,
              text: result.value.viaOrchestrator
                ? "Sent back to the project orchestrator (its worker is gone)"
                : `Sent back to ${whoIsTold(card)}`,
            }
          : failure(result);
      });
    },
  };

  const deferIssue = async (
    issue: ProjectIssue,
    input: { readonly mode: "until"; readonly until: string } | { readonly mode: "end" | "clear" },
  ) =>
    defer({
      environmentId,
      input: { threadId: summary.root.id, reference: issueKey(issue), ...input },
    });

  const laterMenu = (card: DecisionFeedCard) => {
    if (card.blocked) return null;
    const { issue } = card;
    return (
      <LaterControl
        title={issue.title}
        now={() => Date.now()}
        onLater={(until, label) => {
          // A card due within a day comes back at once; saying "hidden" would be false.
          const effect = decisionVisibility({
            deferral: { until, movedToEndAt: null },
            deadline: issue.decision?.deadline,
            now: Date.now(),
          });
          if (!effect.hidden || effect.returnsAt === null) {
            toastManager.add({
              type: "error",
              title: "Due within a day",
              description: "A card with a deadline stays in the feed from the day before it.",
            });
            return;
          }
          const returns = effect.returnsAt;
          perform(
            card,
            `Later: ${label}`,
            { hold: false, undo: () => deferIssue(issue, { mode: "clear" }) },
            async () => {
              const result = await deferIssue(issue, { mode: "until", until });
              return result._tag === "Success"
                ? {
                    ok: true,
                    text: effect.forDeadline
                      ? `Hidden until ${returnTime(returns)}, a day before its deadline`
                      : `Hidden until ${returnTime(returns)}`,
                  }
                : failure(result);
            },
          );
        }}
        onEnd={() =>
          void deferIssue(issue, { mode: "end" }).then((result) => {
            refreshAll();
            if (result._tag === "Success") {
              toastManager.add({ type: "success", title: "Moved to the end" });
            } else {
              const failed = failure(result);
              toastManager.add({ type: "error", title: failed.ok ? "" : failed.error });
            }
          })
        }
      />
    );
  };

  const heldLabels = new Map(undoable.queued.map((entry) => [entry.key, entry.label]));
  const outcomeOf = (card: DecisionFeedCard): FeedOutcome | null => {
    const held = heldLabels.get(card.key);
    if (held) {
      return {
        label: held,
        delivery: { phase: "held" },
        undo: () => undoable.undo(card.key),
        retry: null,
        drop: () => undefined,
      };
    }
    const entry = kept.get(card.key);
    return entry
      ? {
          label: entry.label,
          delivery: entry.delivery,
          undo: entry.undo,
          retry: entry.retry,
          drop: () => record(card.key, null),
        }
      : null;
  };

  // The live cards, with acted-on cards that already left the feed put back where they were.
  const shown = [...feed.cards];
  for (const entry of [...kept.values()].toSorted((a, b) => a.index - b.index)) {
    if (!liveKeys.has(entry.card.key))
      shown.splice(Math.min(entry.index, shown.length), 0, entry.card);
  }

  if (shown.length === 0 && feed.later.length === 0 && feed.chips.length === 0) return null;
  const threads = [summary.root, ...summary.descendants];
  return (
    <ProjectSection title="Decisions" count={feed.total}>
      {feed.chips.length > 1 || project !== null ? (
        <div className="mb-2 flex flex-wrap gap-1">
          <Button
            size="xs"
            variant={project === null ? "secondary" : "ghost-muted"}
            onClick={() => setProject(null)}
          >
            All {feed.total}
          </Button>
          {feed.chips.map((chip) => (
            <Button
              key={chip.project}
              size="xs"
              variant={project === chip.project ? "secondary" : "ghost-muted"}
              onClick={() => setProject(project === chip.project ? null : chip.project)}
            >
              {chip.project} {chip.count}
            </Button>
          ))}
        </div>
      ) : null}
      <ul className="divide-y divide-border">
        {shown.map((card) => (
          <DecisionFeedCardView
            key={card.key}
            card={card}
            environmentId={environmentId}
            now={now}
            decision={decisionOf(card, byKey)}
            pr={card.blocked ? null : reviewPullRequest(card.issue, threads)}
            outcome={outcomeOf(card)}
            actions={actions}
            menu={laterMenu(card)}
          />
        ))}
      </ul>
      {feed.later.length > 0 ? (
        <div className="mt-2 text-xs">
          <InlineButton
            tone="muted"
            aria-expanded={showLater}
            onClick={() => setShowLater((open) => !open)}
          >
            {showLater ? "Hide Later" : `Later ${feed.later.length}`}
          </InlineButton>
          {showLater ? (
            <ul className="mt-1 divide-y divide-border">
              {feed.later.map(({ card, returnsAt, forDeadline }) =>
                card.blocked ? null : (
                  <li key={card.key} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm">{card.issue.title}</span>
                    <span className="shrink-0 text-muted-foreground">
                      back {returnTime(returnsAt)}
                      {forDeadline ? ", a day before its deadline" : ""}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        void deferIssue(card.issue, { mode: "clear" }).then(() => refreshAll())
                      }
                    >
                      Bring back
                    </Button>
                  </li>
                ),
              )}
            </ul>
          ) : null}
        </div>
      ) : null}
    </ProjectSection>
  );
}

/** The parsed ready comment of an approve / review item, when it asks Brad to choose. */
function decisionOf(
  card: DecisionFeedCard,
  byKey: ReadonlyMap<string, NeedsYouItem>,
): NeedsYouDecision | null {
  if (card.blocked || (card.kind === "decision" && card.issue.decision)) return null;
  const item = byKey.get(card.key);
  return item ? needsYouDecision(item) : null;
}
