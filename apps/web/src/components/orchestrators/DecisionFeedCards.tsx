import {
  approvalChoices,
  approvalTitle,
  oneTapQuestion,
  questionAnswers,
} from "@t3tools/client-runtime/decision-ask";
import {
  feedCardOwner,
  withoutDeadlineLine,
  type DecisionFeedCard,
  type FeedPullRequest,
} from "@t3tools/client-runtime/decision-feed";
import { decisionAnswerInput, type DecisionPick } from "@t3tools/client-runtime/decision-answer";
import { deliveryStrip, type FeedDelivery } from "@t3tools/client-runtime/decision-outcome";
import type {
  EnvironmentId,
  ProjectIssue,
  ProjectPendingAsk,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import { CheckIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { DecisionMarkdown } from "./DecisionMarkdown";
import {
  deadlineNote,
  kindLabel,
  LATER_CHOICES,
  laterUntil,
  parseCustomLater,
  pullRequestSummary,
  resultLine,
  reviewMergeState,
} from "./decisionFeed.logic";
import { OptionLinks } from "./LinkifiedText";
import { RowMenu } from "./ProjectSection";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { isNotAnswer, type NeedsYouDecision } from "./projectRequests.logic";
import { TaskTitle } from "./TaskLink";

type QuestionAsk = Extract<ProjectPendingAsk, { kind: "question" }>;
type ApprovalAsk = Extract<ProjectPendingAsk, { kind: "approval" }>;

/** What Brad did on a card and where it stands, shown in place of the card's actions. */
export interface FeedOutcome {
  readonly label: string;
  readonly delivery: FeedDelivery;
  /** Undo for a sent action that can be taken back (Settle, Later). */
  readonly undo: (() => void) | null;
  readonly retry: (() => void) | null;
  /** Gives up on a failed action and shows the card's actions again. */
  readonly drop: () => void;
}

/** Everything a card can do; the feed implements these over the server's commands. */
export interface FeedCardActions {
  readonly openThread: (threadId: string) => void;
  readonly answerQuestion: (
    card: DecisionFeedCard,
    ask: QuestionAsk,
    answers: Record<string, string>,
    label: string,
  ) => void;
  readonly respondApproval: (
    card: DecisionFeedCard,
    ask: ApprovalAsk,
    decision: ProviderApprovalDecision,
    label: string,
  ) => void;
  readonly decideIssue: (
    card: DecisionFeedCard,
    decision: "approve" | "not-yet" | "option" | "answer",
    extra: { readonly option?: string; readonly answer?: string; readonly reason?: string },
    label: string,
  ) => void;
  readonly discuss: (issue: ProjectIssue) => void;
  readonly discussing: string | null;
  readonly settle: (card: DecisionFeedCard, label: string) => void;
  readonly approveMerge: (card: DecisionFeedCard, pr: FeedPullRequest | null) => void;
  readonly sendBack: (card: DecisionFeedCard, note: string, label: string) => void;
}

const AgeAndWho = ({ card, now }: { readonly card: DecisionFeedCard; readonly now: number }) => {
  const owner = feedCardOwner(card);
  const parts: string[] = [];
  if (card.blocked) {
    parts.push(owner ? `${owner.name} is blocked on this` : "A thread is blocked on this");
  } else if (owner) {
    parts.push(`For ${owner.name}${owner.project ? ` in ${owner.project}` : ""}`);
  } else {
    parts.push("For the project orchestrator");
  }
  parts.push(formatIssueAge(card.since, now));
  if (!card.blocked && card.issue.decision?.deadline) {
    const note = deadlineNote(card.issue.decision.deadline, now);
    if (note) parts.push(note);
  }
  if (!card.blocked && card.issue.milestone && card.kind === "test") {
    parts.push(card.issue.milestone.title);
  }
  const standingIn = owner?.standingInFor ?? null;
  return (
    <span className="block text-xs text-muted-foreground">
      {parts.join(" · ")}
      {standingIn ? ` · ${standingIn} is gone, so this reaches the orchestrator` : ""}
    </span>
  );
};

/** One option row: full width, sends on click; the recommended one is labeled, not filled. */
function OptionRow({
  text,
  detail,
  recommended,
  disabled,
  onPick,
}: {
  readonly text: string;
  readonly detail?: string | undefined;
  readonly recommended?: boolean;
  readonly disabled?: boolean;
  readonly onPick: () => void;
}) {
  return (
    <Fragment>
      <Button size="sm-multiline" variant="outline" disabled={disabled} onClick={onPick}>
        <span className="min-w-0 flex-1 text-left wrap-anywhere">
          {text}
          {detail ? (
            <span className="block text-xs font-normal text-muted-foreground">{detail}</span>
          ) : null}
        </span>
        {recommended ? (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">Recommended</span>
        ) : null}
        <SendIcon className="shrink-0 text-muted-foreground" />
      </Button>
      <OptionLinks text={text} />
    </Fragment>
  );
}

/** "Other..." with its own field, for any card whose answer can be free text. */
function OtherAnswer({
  placeholder,
  onSend,
}: {
  readonly placeholder: string;
  readonly onSend: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <span className="text-xs">
        <InlineButton tone="muted" aria-expanded={false} onClick={() => setOpen(true)}>
          Other...
        </InlineButton>
      </span>
    );
  }
  return (
    <span className="flex gap-1">
      <Input
        size="sm"
        value={text}
        maxLength={2000}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && text.trim()) onSend(text);
        }}
      />
      <Button size="xs" variant="outline" disabled={!text.trim()} onClick={() => onSend(text)}>
        <SendIcon />
        Send
      </Button>
    </span>
  );
}

/** A thread's question: one tap on an option, Other..., or answer in the thread. */
function QuestionBody({
  card,
  ask,
  actions,
}: {
  readonly card: DecisionFeedCard;
  readonly ask: QuestionAsk;
  readonly actions: FeedCardActions;
}) {
  const question = oneTapQuestion(ask);
  return (
    <span className="flex max-w-2xl flex-col gap-1">
      {ask.questions.length > 1 ? (
        <span className="text-xs text-muted-foreground">
          {ask.questions.length} questions: answer them in the thread.
        </span>
      ) : null}
      {question ? (
        <>
          {question.options.map((option, index) => (
            <OptionRow
              key={option.label}
              text={option.label}
              detail={option.description}
              onPick={() => {
                const answers = questionAnswers(question, { kind: "option", index });
                if (answers)
                  actions.answerQuestion(card, ask, answers, `Answered: ${option.label}`);
              }}
            />
          ))}
          {question.allowCustomAnswer === false ? null : (
            <OtherAnswer
              placeholder="Your answer"
              onSend={(text) => {
                const answers = questionAnswers(question, { kind: "other", text });
                if (answers) actions.answerQuestion(card, ask, answers, `Answered: ${text.trim()}`);
              }}
            />
          )}
        </>
      ) : null}
      <span className="text-xs">
        <InlineButton tone="muted" onClick={() => actions.openThread(ask.threadId)}>
          Open thread
        </InlineButton>
      </span>
    </span>
  );
}

/** A thread's approval request: the command, and the provider's own choices. */
function ApprovalBody({
  card,
  ask,
  actions,
}: {
  readonly card: DecisionFeedCard;
  readonly ask: ApprovalAsk;
  readonly actions: FeedCardActions;
}) {
  return (
    <span className="flex max-w-2xl flex-col gap-1.5">
      {ask.detail ? (
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs wrap-anywhere whitespace-pre-wrap">
          {ask.detail}
        </pre>
      ) : null}
      <span className="flex flex-wrap items-center gap-1.5">
        {ask.canRespond
          ? approvalChoices(ask).map((choice) => (
              <Button
                key={choice.decision}
                size="xs"
                variant={choice.decision === "accept" ? "default" : "outline"}
                aria-description={choice.warning}
                onClick={() => actions.respondApproval(card, ask, choice.decision, choice.label)}
              >
                {choice.label}
              </Button>
            ))
          : null}
        <span className="text-xs">
          <InlineButton tone="muted" onClick={() => actions.openThread(ask.threadId)}>
            Open thread
          </InlineButton>
        </span>
      </span>
      {ask.canRespond ? null : (
        <span className="text-xs text-muted-foreground">
          {ask.requestId === "pending"
            ? "Open the thread to answer this."
            : "This request outlived its session: resolve it in the thread."}
        </span>
      )}
    </span>
  );
}

/** A decision's options (a needs-brad issue, or a ready comment that lists them) and Other. */
function DecisionOptions({
  card,
  options,
  open,
  actions,
}: {
  readonly card: DecisionFeedCard;
  readonly options: ReadonlyArray<{ text: string; recommended: boolean; sends: string }>;
  /** An open question has no options, only the answer field. */
  readonly open: boolean;
  readonly actions: FeedCardActions;
}) {
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const noteRef = useRef("");
  const change = (value: string) => {
    noteRef.current = value;
    setNote(value);
  };
  const send = (pick: DecisionPick, label: string) => {
    const input = decisionAnswerInput(pick, noteRef.current);
    if (!input) return;
    actions.decideIssue(
      card,
      input.decision,
      {
        ...(input.option ? { option: input.option } : {}),
        ...(input.answer ? { answer: input.answer } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      label,
    );
  };
  return (
    <span className="flex max-w-2xl flex-col gap-1">
      {open ? (
        <OtherAnswer
          placeholder="Answer"
          onSend={(text) => send({ kind: "open", text }, `Answered: ${text.trim()}`)}
        />
      ) : (
        <>
          {options.map((option) => (
            <OptionRow
              key={option.text}
              text={option.text}
              recommended={option.recommended}
              onPick={() =>
                send({ kind: "option", option: option.sends }, `Answered: ${option.text}`)
              }
            />
          ))}
          <OtherAnswer
            placeholder="Your answer"
            onSend={(text) => send({ kind: "other", text }, `Answered: ${text.trim()}`)}
          />
        </>
      )}
      {noteOpen ? (
        <Input
          size="sm"
          value={note}
          maxLength={500}
          placeholder="Note"
          aria-label="Note"
          autoFocus
          onChange={(event) => change(event.target.value)}
        />
      ) : null}
      <span className="flex items-center gap-3 text-xs">
        {noteOpen ? null : (
          <InlineButton tone="muted" onClick={() => setNoteOpen(true)}>
            Add note
          </InlineButton>
        )}
        {card.blocked ? null : (
          <InlineButton
            tone="muted"
            disabled={actions.discussing === `${card.issue.repository}#${card.issue.number}`}
            onClick={() => actions.discuss(card.issue)}
          >
            {actions.discussing === `${card.issue.repository}#${card.issue.number}`
              ? "Opening..."
              : "Discuss"}
          </InlineButton>
        )}
      </span>
    </span>
  );
}

/** A ready comment that asks Brad to approve, or to choose among "Option A:" lines. */
function ApproveBody({
  card,
  decision,
  actions,
}: {
  readonly card: DecisionFeedCard;
  readonly decision: NeedsYouDecision;
  readonly actions: FeedCardActions;
}) {
  const [reason, setReason] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  return (
    <span className="flex max-w-2xl flex-col gap-1">
      {decision.options.length === 0 ? (
        <Button
          size="sm-multiline"
          variant="outline"
          onClick={() => actions.decideIssue(card, "approve", {}, "Approved")}
        >
          <CheckIcon />
          <span className="min-w-0 flex-1 text-left">Approve</span>
        </Button>
      ) : (
        decision.options.map((option) => (
          <OptionRow
            key={option.label}
            text={`${option.label}: ${option.text}`}
            onPick={() =>
              actions.decideIssue(
                card,
                "option",
                { option: `${option.label}: ${option.text}` },
                `Chose ${option.label}`,
              )
            }
          />
        ))
      )}
      {reasonOpen ? (
        <Input
          size="sm"
          value={reason}
          maxLength={500}
          placeholder="Reason"
          aria-label="Reason for not yet"
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
      ) : null}
      <span className="flex items-center gap-3 text-xs">
        <InlineButton
          tone="muted"
          onClick={() =>
            actions.decideIssue(
              card,
              "not-yet",
              reason.trim() ? { reason: reason.trim() } : {},
              "Not yet",
            )
          }
        >
          Not yet
        </InlineButton>
        {reasonOpen ? null : (
          <InlineButton tone="muted" onClick={() => setReasonOpen(true)}>
            Add reason
          </InlineButton>
        )}
        {card.blocked ? null : (
          <InlineButton
            tone="muted"
            disabled={actions.discussing === `${card.issue.repository}#${card.issue.number}`}
            onClick={() => actions.discuss(card.issue)}
          >
            {actions.discussing === `${card.issue.repository}#${card.issue.number}`
              ? "Opening..."
              : "Discuss"}
          </InlineButton>
        )}
      </span>
    </span>
  );
}

/** A note field with its Send, for Send back and Broken. */
function NoteSend({
  placeholder,
  button,
  onSend,
}: {
  readonly placeholder: string;
  readonly button: string;
  readonly onSend: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <span className="flex gap-1">
      <Input
        size="sm"
        value={note}
        maxLength={2000}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && note.trim()) onSend(note);
        }}
      />
      <Button size="xs" variant="outline" disabled={!note.trim()} onClick={() => onSend(note)}>
        <SendIcon />
        {button}
      </Button>
    </span>
  );
}

/** Review: Approve and merge, Send back, and Settle without merging. */
function ReviewBody({
  card,
  pr,
  actions,
}: {
  readonly card: DecisionFeedCard;
  readonly pr: FeedPullRequest | null;
  readonly actions: FeedCardActions;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const merge = reviewMergeState(pr);
  return (
    <span className="flex max-w-2xl flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="default"
          disabled={!merge.canMerge}
          onClick={() => actions.approveMerge(card, pr)}
        >
          Approve and merge
        </Button>
        {merge.rebaseNote ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => actions.sendBack(card, merge.rebaseNote!, "Sent back: rebase onto main")}
          >
            Send back: rebase onto main
          </Button>
        ) : null}
        <Button size="xs" variant="outline" onClick={() => setNoteOpen((open) => !open)}>
          Send back with note
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => actions.settle(card, "Settled without merging")}
        >
          Settle without merging
        </Button>
      </span>
      {noteOpen ? (
        <NoteSend
          placeholder="What to change"
          button="Send back"
          onSend={(note) => actions.sendBack(card, note, "Sent back with a note")}
        />
      ) : null}
      {merge.note ? <span className="text-xs text-muted-foreground">{merge.note}</span> : null}
    </span>
  );
}

/** Test: Works settles, Broken sends it back with what broke. */
function TestBody({
  card,
  actions,
}: {
  readonly card: DecisionFeedCard;
  readonly actions: FeedCardActions;
}) {
  const [brokenOpen, setBrokenOpen] = useState(false);
  return (
    <span className="flex max-w-2xl flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={() => actions.settle(card, "Works")}>
          <CheckIcon />
          Works
        </Button>
        <Button size="xs" variant="outline" onClick={() => setBrokenOpen((open) => !open)}>
          Broken
        </Button>
      </span>
      {brokenOpen ? (
        <NoteSend
          placeholder="What broke"
          button="Send back"
          onSend={(note) => actions.sendBack(card, `Broken: ${note.trim()}`, "Sent back: broken")}
        />
      ) : null}
    </span>
  );
}

/** The agent's summary or the thread's answer under an issue card, as Markdown. */
function issueBody(
  card: Extract<DecisionFeedCard, { blocked: false }>,
  decision: NeedsYouDecision | null,
): string {
  const { issue } = card;
  if (card.kind === "decision" && issue.decision)
    return withoutDeadlineLine(issue.decision.context);
  if (decision) return decision.detail;
  if (card.kind === "test") return card.testStep ? `Test: ${card.testStep}` : "";
  const comment = issue.latestComment;
  return comment && !isNotAnswer(comment.body) ? comment.body : (issue.answer?.text ?? "");
}

/** What a card shows once Brad acted: what he did, where it is, and Undo / Retry. */
function OutcomeStrip({ outcome }: { readonly outcome: FeedOutcome }) {
  const strip = deliveryStrip(outcome.delivery);
  const undo = strip.undoable || (outcome.delivery.phase === "sent" && outcome.undo !== null);
  return (
    <span className="flex max-w-2xl flex-col gap-1">
      <span className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 text-foreground">{outcome.label}</span>
        {undo ? (
          <Button size="xs" variant="ghost-muted" onClick={outcome.undo ?? undefined}>
            <RotateCcwIcon />
            Undo
          </Button>
        ) : null}
      </span>
      <span
        role={strip.retryable ? "alert" : "status"}
        className={`text-xs ${strip.retryable ? "text-destructive" : "text-muted-foreground"}`}
      >
        {strip.text}
      </span>
      {strip.retryable ? (
        <span className="flex gap-1">
          {outcome.retry ? (
            <Button size="xs" variant="outline" onClick={outcome.retry}>
              <RotateCcwIcon />
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={outcome.drop}>
            Choose again
          </Button>
        </span>
      ) : null}
    </span>
  );
}

function CardTitle({ card }: { readonly card: DecisionFeedCard }) {
  if (card.kind === "question") {
    return (
      <span className="text-sm">
        {card.ask.questions[0]?.question ?? `${card.ask.threadTitle} has a question`}
      </span>
    );
  }
  if (card.kind === "approval") {
    return <span className="text-sm">{approvalTitle(card.ask)}</span>;
  }
  if (card.kind === "plan") {
    return <span className="text-sm">{card.plan.title}: plan ready for review</span>;
  }
  return (
    <TaskTitle
      task={{ host: card.issue.host, repository: card.issue.repository, number: card.issue.number }}
      url={card.issue.url}
      className="text-sm hover:underline"
    >
      {card.issue.title}
    </TaskTitle>
  );
}

/** One card of the feed: kind, title, who it is for and how long, its context, then its actions. */
export function DecisionFeedCardView({
  card,
  environmentId,
  now,
  decision,
  pr,
  outcome,
  actions,
  menu,
}: {
  readonly card: DecisionFeedCard;
  readonly environmentId: EnvironmentId;
  readonly now: number;
  /** The parsed ready comment when the card asks to approve or choose among options. */
  readonly decision: NeedsYouDecision | null;
  readonly pr: FeedPullRequest | null;
  readonly outcome: FeedOutcome | null;
  readonly actions: FeedCardActions;
  /** The Later menu, for cards that are issues. */
  readonly menu: ReactNode;
}) {
  // A ready comment that lists options or asks for approval is a decision whatever its group.
  const effective: DecisionFeedCard =
    !card.blocked && decision !== null
      ? { ...card, kind: "decision", approve: decision.options.length === 0 }
      : card;
  const label = kindLabel(effective);
  const owner = feedCardOwner(card);
  let body: ReactNode = null;
  let controls: ReactNode = null;
  if (card.blocked) {
    if (card.kind === "question")
      controls = <QuestionBody card={card} ask={card.ask} actions={actions} />;
    else if (card.kind === "approval")
      controls = <ApprovalBody card={card} ask={card.ask} actions={actions} />;
    else {
      controls = (
        <Button size="xs" variant="outline" onClick={() => actions.openThread(card.plan.threadId)}>
          Open thread
        </Button>
      );
    }
  } else {
    const markdown = issueBody(card, decision);
    body = markdown ? (
      <DecisionMarkdown
        environmentId={environmentId}
        markdown={markdown}
        issueUrl={card.issue.url}
      />
    ) : null;
    if (decision) {
      controls = <ApproveBody card={card} decision={decision} actions={actions} />;
    } else if (card.kind === "decision" && card.issue.decision) {
      controls = (
        <DecisionOptions
          card={card}
          open={card.issue.decision.options.length === 0}
          options={card.issue.decision.options.map((option) => ({
            text: option.text,
            recommended: option.recommended,
            sends: option.text,
          }))}
          actions={actions}
        />
      );
    } else if (card.kind === "review") {
      controls = <ReviewBody card={card} pr={pr} actions={actions} />;
    } else if (card.kind === "test") {
      controls = <TestBody card={card} actions={actions} />;
    } else {
      controls = (
        <Button size="xs" variant="outline" onClick={() => actions.settle(card, "Settled")}>
          <CheckIcon />
          Settle
        </Button>
      );
    }
  }
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <CardTitle card={card} />
        {menu ? <span className="ml-auto self-center">{menu}</span> : null}
      </span>
      <AgeAndWho card={card} now={now} />
      {!card.blocked && card.kind === "review" && pr ? (
        <span className="text-xs text-muted-foreground">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {pullRequestSummary(pr)}
          </a>
          {pr.conflicting ? " · conflicts with main" : ""}
        </span>
      ) : null}
      {body}
      {outcome ? (
        <OutcomeStrip outcome={outcome} />
      ) : (
        <>
          {controls}
          <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span>{resultLine(effective, owner?.name ?? null)}</span>
            {!card.blocked && card.issue.owner ? (
              <InlineButton
                tone="muted"
                onClick={() => actions.openThread(card.issue.owner!.threadId)}
              >
                Open thread
              </InlineButton>
            ) : null}
          </span>
        </>
      )}
    </li>
  );
}

/**
 * Later on a card: 15 minutes, 1 day or a custom time hide it until then (nobody is told),
 * and Move to end sends it behind the others. Cards come back on their own, and a
 * Later section lists them with Bring back.
 */
export function LaterControl({
  title,
  now,
  onLater,
  onEnd,
}: {
  readonly title: string;
  readonly now: () => number;
  readonly onLater: (until: string, label: string) => void;
  readonly onEnd: () => void;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const until = custom === null ? null : parseCustomLater(custom, now());
  return (
    <span className="flex items-center gap-1">
      {custom === null ? null : (
        <>
          <Input
            size="sm"
            type="datetime-local"
            value={custom}
            aria-label="Show again at"
            onChange={(event) => setCustom(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={until === null}
            onClick={() => {
              if (until) onLater(until, new Date(until).toLocaleString());
              setCustom(null);
            }}
          >
            Later
          </Button>
          <Button size="xs" variant="ghost-muted" onClick={() => setCustom(null)}>
            Cancel
          </Button>
        </>
      )}
      <RowMenu
        label={title}
        items={[
          ...LATER_CHOICES.map((choice) => ({
            label: `Later: ${choice.label}`,
            onClick: () => onLater(laterUntil(now(), choice.ms), choice.label),
          })),
          { label: "Later: custom time...", onClick: () => setCustom("") },
          { label: "Move to end", onClick: onEnd },
        ]}
      />
    </span>
  );
}
