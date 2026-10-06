import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  decisionAnswerInput,
  decisionSendStrip,
  keptDecisionAnswers,
  sentDelivery,
  waitingLabel,
  type DecisionAnswerInput,
  type DecisionAnswerRecord,
  type DecisionDelivery,
  type DecisionPick,
} from "@t3tools/client-runtime/decision-answer";
import type { ProjectIssue } from "@t3tools/contracts";
import { RotateCcwIcon, SendIcon } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { DecisionContext } from "./DecisionContext";
import { deriveDecisions } from "./decisions.logic";
import { OptionLinks } from "./LinkifiedText";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { issueKey } from "./projectRequests.logic";
import { ProjectSection } from "./ProjectSection";
import {
  useDecide,
  useDiscuss,
  useProjectRequests,
  useUndoableActions,
} from "./ProjectRequestsSection";

const pickText = (pick: DecisionPick) => (pick.kind === "option" ? pick.option : pick.text);

/** An answered card: what was picked and where the answer is, until the card leaves. */
interface AnsweredState {
  readonly answered: string;
  readonly state: "held" | DecisionDelivery;
}

/**
 * One decision's answer controls, under its context. Each option is a full-width
 * row that sends on click (the recommended one is labeled, not filled); from then
 * on the row shows the answer with its status (held with Undo, sending, sent, or
 * failed with Retry) and never the options again unless the answer is dropped.
 * A note can be added before picking or, until the hold ends, after: it is read
 * when the answer is sent.
 * Discuss opens a thread to talk it through first; the decision stays here.
 */
function DecisionAnswer({
  decision,
  waiting,
  answered,
  discussing,
  onAnswer,
  onUndo,
  onRetry,
  onDrop,
  onDiscuss,
}: {
  readonly decision: NonNullable<ProjectIssue["decision"]>;
  /** Who the answer goes to, in words. */
  readonly waiting: string;
  readonly answered: AnsweredState | null;
  readonly discussing: boolean;
  readonly onAnswer: (pick: DecisionPick, readNote: () => string) => void;
  readonly onUndo: () => void;
  readonly onRetry: () => void;
  /** Gives up on a failed answer and shows the options again. */
  readonly onDrop: () => void;
  readonly onDiscuss: () => void;
}) {
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [text, setText] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const noteRef = useRef("");
  const open = decision.options.length === 0;
  const answer = (pick: DecisionPick) => {
    if (!decisionAnswerInput(pick, "")) return;
    onAnswer(pick, () => noteRef.current);
  };
  const changeNote = (value: string) => {
    noteRef.current = value;
    setNote(value);
  };
  const noteField = noteOpen ? (
    <Input
      size="sm"
      value={note}
      maxLength={500}
      placeholder="Note"
      aria-label="Note"
      autoFocus
      onChange={(event) => changeNote(event.target.value)}
    />
  ) : null;
  const noteLink = noteOpen ? null : (
    <span className="text-xs">
      <InlineButton tone="muted" onClick={() => setNoteOpen(true)}>
        Add note
      </InlineButton>
    </span>
  );
  if (answered) {
    const strip = decisionSendStrip(answered.state, waiting);
    return (
      <span className="flex max-w-2xl flex-col gap-1">
        <span className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 text-foreground">{answered.answered}</span>
          {strip.undoable ? (
            <Button size="xs" variant="ghost-muted" onClick={onUndo}>
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
            <Button size="xs" variant="outline" onClick={onRetry}>
              <RotateCcwIcon />
              Retry
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={onDrop}>
              Choose again
            </Button>
          </span>
        ) : null}
        {answered.state === "held" ? (
          <>
            {noteField}
            {noteLink}
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex max-w-2xl flex-col gap-1">
      {open ? (
        <span className="flex gap-1">
          <Input
            size="sm"
            value={text}
            maxLength={2000}
            placeholder="Answer"
            aria-label="Answer"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") answer({ kind: "open", text });
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={!text.trim()}
            onClick={() => answer({ kind: "open", text })}
          >
            <SendIcon />
            Send
          </Button>
        </span>
      ) : (
        <>
          <span className="flex flex-col gap-1">
            {decision.options.map((option) => (
              <Fragment key={option.text}>
                <Button
                  size="sm-multiline"
                  variant="outline"
                  onClick={() => answer({ kind: "option", option: option.text })}
                >
                  <span className="min-w-0 flex-1 text-left wrap-anywhere">{option.text}</span>
                  {option.recommended ? (
                    <span className="shrink-0 text-xs font-normal text-muted-foreground">
                      Recommended
                    </span>
                  ) : null}
                  <SendIcon className="shrink-0 text-muted-foreground" />
                </Button>
                <OptionLinks text={option.text} />
              </Fragment>
            ))}
            <span className="text-xs">
              <InlineButton
                tone="muted"
                aria-expanded={otherOpen}
                onClick={() => setOtherOpen((current) => !current)}
              >
                Other...
              </InlineButton>
            </span>
          </span>
          {otherOpen ? (
            <span className="flex gap-1">
              <Input
                size="sm"
                value={text}
                maxLength={2000}
                placeholder="Your answer"
                aria-label="Other answer"
                autoFocus
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") answer({ kind: "other", text });
                }}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={!text.trim()}
                onClick={() => answer({ kind: "other", text })}
              >
                <SendIcon />
                Send
              </Button>
            </span>
          ) : null}
        </>
      )}
      {noteField}
      <span className="flex items-center gap-3 text-xs">
        {noteLink}
        <InlineButton tone="muted" disabled={discussing} onClick={onDiscuss}>
          {discussing ? "Opening..." : "Discuss"}
        </InlineButton>
      </span>
    </span>
  );
}

/**
 * Decisions waiting on Brad: open `needs-brad` issues in the fixed decision format.
 * Picking an option (or Other...) holds the answer for a few seconds with Undo, then
 * comments it on the issue and sends it to the waiting thread. The row keeps showing
 * the answer until a list read after it was sent no longer has the issue; a failure
 * stays on the row with the server's reason and Retry.
 */
export function ProjectDecisionsWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, now } = useProjectRequests(summary);
  const actions = useUndoableActions();
  const decide = useDecide(summary, query.refresh);
  const discuss = useDiscuss(summary);
  const decisions = useMemo(() => deriveDecisions(query.data?.issues ?? []), [query.data]);
  const live = useMemo(() => new Set(decisions.map(issueKey)), [decisions]);
  const [answers, setAnswers] = useState<ReadonlyMap<string, DecisionAnswerRecord<ProjectIssue>>>(
    new Map(),
  );
  // Answers whose card has left are forgotten on each new list read, so a question
  // asked again shows its options.
  const [prunedAt, setPrunedAt] = useState(now);
  if (prunedAt !== now) {
    setPrunedAt(now);
    setAnswers((current) => keptDecisionAnswers(current, live, now));
  }
  const kept = keptDecisionAnswers(answers, live, now);
  const record = (key: string, entry: DecisionAnswerRecord<ProjectIssue> | null) =>
    setAnswers((current) => {
      const next = new Map(current);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });
  const send = async (key: string, entry: Omit<DecisionAnswerRecord<ProjectIssue>, "delivery">) => {
    record(key, { ...entry, delivery: { phase: "sending" } });
    const { input } = entry;
    const outcome = await decide(entry.issue, input.decision, {
      ...(input.option ? { option: input.option } : {}),
      ...(input.answer ? { answer: input.answer } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    record(key, {
      ...entry,
      delivery: outcome.sent
        ? sentDelivery(outcome.notified)
        : { phase: "failed", error: outcome.error },
    });
  };
  const held = new Map(actions.queued.map((entry) => [entry.key, entry.label]));
  const shown = [
    ...decisions,
    ...[...kept].filter(([key]) => !live.has(key)).map(([, entry]) => entry.issue),
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const answeredOf = (key: string): AnsweredState | null => {
    const label = held.get(key);
    if (label) return { answered: label, state: "held" };
    const entry = kept.get(key);
    return entry ? { answered: entry.answered, state: entry.delivery } : null;
  };
  const answer = (issue: ProjectIssue, key: string, pick: DecisionPick, readNote: () => string) => {
    const answered = `Answered: ${pickText(pick).trim()}`;
    actions.run(key, answered, async () => {
      const input: DecisionAnswerInput | null = decisionAnswerInput(pick, readNote());
      if (!input) return false;
      await send(key, { issue, answered, input });
      return true;
    });
  };
  const retry = (key: string) => {
    const entry = kept.get(key);
    if (entry) void send(key, entry);
  };
  if (shown.length === 0) return null;
  const threads = [summary.root, ...summary.descendants];
  return (
    <ProjectSection title="Decisions" count={shown.length}>
      <ul className="divide-y divide-border">
        {shown.map((issue) => {
          const decision = issue.decision!;
          const key = issueKey(issue);
          const waiting = waitingLabel(decision.waiting, threads);
          return (
            <li key={key} className="flex flex-col gap-2 py-2">
              <span>
                <span className="block text-sm">{issue.title}</span>
                {decision.context ? (
                  <DecisionContext
                    environmentId={summary.root.environmentId}
                    text={decision.context}
                    issueUrl={issue.url}
                  />
                ) : null}
                <span className="mt-1 block text-xs text-muted-foreground">
                  For {waiting} · {formatIssueAge(issue.createdAt, now)}
                </span>
              </span>
              <DecisionAnswer
                decision={decision}
                waiting={waiting}
                answered={answeredOf(key)}
                discussing={discuss.pending === key}
                onAnswer={(pick, readNote) => answer(issue, key, pick, readNote)}
                onUndo={() => actions.undo(key)}
                onRetry={() => retry(key)}
                onDrop={() => record(key, null)}
                onDiscuss={() => void discuss.start(issue)}
              />
            </li>
          );
        })}
      </ul>
    </ProjectSection>
  );
}
