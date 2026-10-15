import { cardFullText, cardSummary } from "@t3tools/client-runtime/decision-card";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { readThreadShells } from "../../state/entities";
import { resolveThreadLinkTarget } from "../../state/threadLinks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { InlineButton } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { DecisionMarkdown } from "../orchestrators/DecisionMarkdown";
import { useDiscuss } from "../orchestrators/ProjectRequestsSection";
import { issueKey } from "../orchestrators/projectRequests.logic";
import { useDashboardUi, type DecisionRow } from "./context";
import { formatDeadline, parseIssueTaskId } from "./dashboard.logic";
import { DecisionAnswerArea } from "./DecisionAnswerArea";
import { toldOf, useAnswerPlan } from "./useDecisionAnswers";

const KIND_WORD = {
  decision: "decision",
  question: "question",
  approval: "approval",
  review: "review",
  test: "test",
} as const;

/** "T3 Code · blocks fork.13": the project, and what waits on this answer when the snapshot knows. */
function consequence(row: DecisionRow): string {
  const { project } = row.scoped;
  const titles = row.attention.blockingTaskIds
    .map((id) => project.tasks.find((task) => task.id === id)?.title)
    .filter((title): title is string => !!title);
  if (titles.length === 0) return project.title;
  return `${project.title} · blocks ${titles[0]}${titles.length > 1 ? ` and ${titles.length - 1} more` : ""}`;
}

/** The lead of the question, for the compact feed; the full text opens in the card. */
const lead = (question: string) =>
  question
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

/** Opens the issue's task view, or the waiting thread when the decision has no issue. */
function useOpenDecisionSource() {
  const ui = useDashboardUi();
  const navigate = useNavigate();
  return (row: DecisionRow) => {
    const task = row.scoped.project.tasks.find(
      (candidate) => candidate.id === row.attention.taskId,
    );
    if (task && row.attention.url) {
      ui.openTask(row.scoped, task);
      return;
    }
    const threadId = row.attention.threadId;
    if (threadId) {
      const target = resolveThreadLinkTarget(row.scoped.environmentId, threadId);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
      });
    }
  };
}

/**
 * Opens a thread to talk the decision through with the project, through the same Discuss the
 * Decisions feed uses. Only an issue-backed decision in a project with a head thread has one.
 */
function DiscussButton({ row }: { readonly row: DecisionRow }) {
  const issue = parseIssueTaskId(row.attention.taskId);
  const rootId = row.scoped.project.rootThreadId;
  if (!issue || !rootId) return null;
  return <DiscussIssue environmentId={row.scoped.environmentId} rootId={rootId} issue={issue} />;
}

function DiscussIssue({
  environmentId,
  rootId,
  issue,
}: {
  readonly environmentId: DecisionRow["scoped"]["environmentId"];
  readonly rootId: NonNullable<DecisionRow["scoped"]["project"]["rootThreadId"]>;
  readonly issue: NonNullable<ReturnType<typeof parseIssueTaskId>>;
}) {
  const discuss = useDiscuss({ root: { environmentId, id: rootId } });
  const pending = discuss.pending === issueKey(issue);
  return (
    <InlineButton tone="muted" disabled={pending} onClick={() => void discuss.start(issue)}>
      {pending ? "Opening" : "Discuss"}
    </InlineButton>
  );
}

const URL_PATTERN = /(https?:\/\/[^\s)]+)/g;

/** Where to look, with its links live: a URL in the text opens in a new tab. */
function JudgingWhere({ text, oneLine }: { readonly text: string; readonly oneLine: boolean }) {
  return (
    <div
      className={
        oneLine ? "truncate text-xs text-muted-foreground" : "text-xs text-muted-foreground"
      }
    >
      Where:{" "}
      {text.split(URL_PATTERN).map((part, index) =>
        index % 2 === 1 ? (
          <a
            key={`${index % 2 === 1 ? "link" : "text"}:${part}`}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            {part}
          </a>
        ) : (
          <span key={`${index % 2 === 1 ? "link" : "text"}:${part}`}>{part}</span>
        ),
      )}
    </div>
  );
}

/**
 * One decision, saying what it asks (a sentence on what changed or is proposed, where to look, the
 * recommended answer) and answering it right here through the shared answer area. After an answer
 * the card shows what was sent and where it landed, with Undo while held. `full` adds the whole
 * text; the feed shows its first sentence. `compact` is the tray strip: the sentence and the
 * options, the rest behind Details.
 */
export function DecisionCard({
  row,
  full = false,
  compact = false,
}: {
  readonly row: DecisionRow;
  readonly full?: boolean;
  readonly compact?: boolean;
}) {
  const ui = useDashboardUi();
  const { answers } = ui;
  const openSource = useOpenDecisionSource();
  const navigate = useNavigate();
  const { attention, scoped } = row;
  const state = answers.stateOf(row.key);
  const plan = useAnswerPlan(row);
  const [details, setDetails] = useState(false);
  const told = toldOf(row);

  if (state) {
    const record = state.kind === "record" ? state.record : null;
    const failed = record?.delivery.phase === "failed";
    const landedThread =
      record?.delivery.phase === "sent" ? record.delivery.landed?.threadId : undefined;
    // The thread that was told can differ from the project (a needs-brad decision names its own).
    const toldTitle = landedThread
      ? readThreadShells().find((thread) => thread.id === landedThread)?.title
      : undefined;
    const text = answers.receipt(
      state.kind === "held" ? state.label : (record?.label ?? ""),
      state.kind === "held" ? "held" : state.record.delivery,
      toldTitle ?? told,
    );
    return (
      <div className="py-1.5" data-testid="decision-card">
        <div className="flex items-baseline gap-2">
          {failed ? (
            <span className="text-destructive-foreground">!</span>
          ) : (
            <CheckIcon className="size-3.5 shrink-0 translate-y-0.5 text-success" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{attention.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 pl-5 text-xs text-muted-foreground">
          <span>{text}</span>
          {state.kind === "held" ? (
            <InlineButton tone="muted" autoFocus onClick={state.undo}>
              Undo
            </InlineButton>
          ) : failed ? (
            <>
              {record?.retry ? (
                <InlineButton tone="muted" onClick={record.retry}>
                  Retry
                </InlineButton>
              ) : null}
              <InlineButton tone="muted" onClick={() => answers.dismiss(row.key)}>
                {answers.draftOf(row.key) ? "Edit" : "Dismiss"}
              </InlineButton>
            </>
          ) : null}
          {landedThread ? (
            <InlineButton
              tone="muted"
              onClick={() => {
                // The thread that was told opens in the environment that holds it.
                const target = resolveThreadLinkTarget(
                  scoped.environmentId,
                  landedThread as ThreadId,
                );
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(
                    scopeThreadRef(target.environmentId, target.threadId),
                  ),
                });
              }}
            >
              View in thread
            </InlineButton>
          ) : null}
        </div>
      </div>
    );
  }

  const summary = cardSummary(attention);
  // "See all" shows the whole text the producer wrote; the feed and tray keep to the summary.
  const fullText = full ? cardFullText(attention) : null;
  const asksNothing = attention.asksNothingYet === true;
  const marked = attention.options.some((option) => option.recommended);
  // The tray keeps the four parts in view: Where stays on one line, only the unmarked Recommended
  // line waits behind Details.
  const hasDetails = !!attention.recommended && !marked;
  const showDetails = !compact || details;
  // Links are secondary: Discuss where talking it through is a real alternative, Open where the
  // thing to judge lives elsewhere. A live thread question or approval needs neither.
  const links =
    plan.mode === "questions" || plan.mode === "approval" ? null : (
      <>
        {plan.mode === "issue" ? (
          plan.discuss ? (
            <DiscussButton row={row} />
          ) : null
        ) : (
          <DiscussButton row={row} />
        )}
        <InlineButton tone="muted" onClick={() => openSource(row)}>
          {plan.mode === "open" ? "Open" : "Open task"}
        </InlineButton>
      </>
    );
  return (
    <div className="py-1.5" data-testid="decision-card">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-2xs whitespace-nowrap text-warning-foreground">
          {attention.deadline
            ? `by ${formatDeadline(attention.deadline, ui.now)}`
            : KIND_WORD[attention.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{attention.title}</span>
      </div>
      <div className="text-xs text-muted-foreground">{consequence(row)}</div>
      {asksNothing ? (
        <div className="text-xs text-warning-foreground">
          Asks nothing yet: the agent has not said what to check or decide.
        </div>
      ) : summary ? (
        full ? (
          <div className="my-1.5">
            <DecisionMarkdown
              environmentId={scoped.environmentId}
              markdown={fullText ?? summary}
              issueUrl={attention.url ?? "https://localhost/"}
              clamp={12}
            />
          </div>
        ) : (
          <div className={compact ? "line-clamp-2 text-xs" : "line-clamp-3 text-xs"}>
            {lead(summary)}
          </div>
        )
      ) : null}
      {compact && hasDetails ? (
        <div className="text-xs">
          <InlineButton
            tone="muted"
            aria-expanded={details}
            onClick={() => setDetails((current) => !current)}
          >
            {details ? "Less" : "Details"}
          </InlineButton>
        </div>
      ) : null}
      {attention.judgingWhere ? (
        <JudgingWhere text={attention.judgingWhere} oneLine={compact} />
      ) : null}
      {showDetails && attention.recommended && !marked ? (
        <div className="text-xs text-muted-foreground">
          Recommended: <span className="text-foreground">{attention.recommended}</span>
        </div>
      ) : null}
      <DecisionAnswerArea row={row} plan={plan} answers={answers} compact={compact}>
        {links}
      </DecisionAnswerArea>
    </div>
  );
}

/**
 * The one Decisions feed, in the order of its ranking. Answered cards that already left the
 * snapshot stay up for a few seconds with what happened, so an answer never just vanishes.
 */
export function DecisionList({ limit }: { readonly limit?: number | undefined }) {
  const { decisions, answers } = useDashboardUi();
  const live = new Set(decisions.map((row) => row.key));
  const shown = limit ? decisions.slice(0, limit) : decisions;
  const gone = [...answers.records.values()].filter((record) => !live.has(record.row.key));
  if (shown.length === 0 && gone.length === 0)
    return <div className="py-1 text-muted-foreground/80">Nothing needs you</div>;
  return (
    <div className="flex flex-col divide-y divide-border">
      {shown.map((row) => (
        <DecisionCard key={row.key} row={row} />
      ))}
      {gone.map((record) => (
        <DecisionCard key={record.row.key} row={record.row} />
      ))}
      {limit && decisions.length > limit ? (
        <div className="py-1.5 text-xs text-muted-foreground">+{decisions.length - limit} more</div>
      ) : null}
    </div>
  );
}

/** The decision cards behind an amber "waiting on you" link, opened in place. */
export function DecisionDialog({
  keys,
  onClose,
}: {
  readonly keys: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  const { decisions, answers } = useDashboardUi();
  const rows = keys.flatMap((key) => {
    const live = decisions.find((row) => row.key === key);
    return live ? [live] : answers.records.has(key) ? [answers.records.get(key)!.row] : [];
  });
  return (
    <Dialog open={keys.length > 0} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Waiting on you</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col divide-y divide-border px-6 pb-5">
          {rows.length === 0 ? (
            <div className="py-2 text-muted-foreground">Already answered</div>
          ) : (
            rows.map((row) => <DecisionCard key={row.key} row={row} full />)
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
