import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  decisionAnswerInput,
  decisionSendStrip,
  type DecisionPick,
} from "@t3tools/client-runtime/decision-answer";
import type { ProjectIssue } from "@t3tools/contracts";
import { RotateCcwIcon, SendIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { deriveDecisions } from "./decisions.logic";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { issueKey } from "./projectRequests.logic";
import { useDecide, useProjectRequests, useUndoableActions } from "./ProjectRequestsSection";

/** How long "Sent" stays on a decision before its row leaves. */
const SENT_LINGER_MS = 1500;

type SendPhase = "held" | "sending" | "sent";

const pickText = (pick: DecisionPick) => (pick.kind === "option" ? pick.option : pick.text);

const linkButton = "text-xs text-muted-foreground underline-offset-2 hover:underline";

/**
 * One decision's answer controls. Options send on click, then the row shows a strip
 * (held with Undo, sending, Sent). A note can be added before picking or, until the
 * hold ends, after: it is read when the answer is sent.
 */
function DecisionAnswer({
  decision,
  phase,
  onAnswer,
  onUndo,
}: {
  readonly decision: NonNullable<ProjectIssue["decision"]>;
  readonly phase: SendPhase | null;
  readonly onAnswer: (pick: DecisionPick, readNote: () => string) => void;
  readonly onUndo: () => void;
}) {
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [text, setText] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const noteRef = useRef("");
  const open = decision.options.length === 0;
  const answer = (pick: DecisionPick) => {
    if (!decisionAnswerInput(pick, "")) return;
    setPicked(pickText(pick).trim());
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
    <button type="button" className={linkButton} onClick={() => setNoteOpen(true)}>
      Add note
    </button>
  );
  if (phase) {
    const strip = decisionSendStrip(phase, decision.waiting);
    return (
      <span className="flex w-60 shrink-0 flex-col gap-1">
        <span className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-foreground">{strip.text}</span>
          {strip.undoable ? (
            <Button size="xs" variant="ghost-muted" onClick={onUndo}>
              <RotateCcwIcon />
              Undo
            </Button>
          ) : null}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground">{picked}</span>
        {phase === "held" ? (
          <>
            {noteField}
            {noteLink}
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex w-60 shrink-0 flex-col gap-1">
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
          <span className="flex flex-wrap gap-1">
            {decision.options.map((option) => (
              <Button
                key={option.text}
                size="sm-multiline"
                variant={option.recommended ? "default" : "outline"}
                className="max-w-full text-left"
                onClick={() => answer({ kind: "option", option: option.text })}
              >
                {option.text}
                {option.recommended ? (
                  <span className="text-xs font-normal opacity-70">recommended</span>
                ) : null}
                <SendIcon className="size-3 shrink-0 opacity-60" />
              </Button>
            ))}
            <Button
              size="sm-multiline"
              variant="ghost-muted"
              aria-expanded={otherOpen}
              onClick={() => setOtherOpen((current) => !current)}
            >
              Other...
            </Button>
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
      {noteLink}
    </span>
  );
}

/**
 * Decisions waiting on Brad: open `needs-brad` issues in the fixed decision format.
 * Picking an option (or Other...) holds the answer for a few seconds with Undo while
 * the row shows where it is going, then comments it on the issue and sends it to the
 * waiting thread; the row reads Sent before it leaves.
 */
export function ProjectDecisionsWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, now } = useProjectRequests(summary);
  const actions = useUndoableActions();
  const decide = useDecide(summary, query.refresh);
  const decisions = useMemo(() => deriveDecisions(query.data?.issues ?? []), [query.data]);
  const [flight, setFlight] = useState<
    ReadonlyMap<string, { readonly phase: "sending" | "sent"; readonly issue: ProjectIssue }>
  >(new Map());
  const setPhase = (
    key: string,
    entry: { phase: "sending" | "sent"; issue: ProjectIssue } | null,
  ) =>
    setFlight((current) => {
      const next = new Map(current);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });
  const heldKeys = new Set(actions.queued.map((entry) => entry.key));
  const live = new Set(decisions.map(issueKey));
  const shown = [
    ...decisions,
    ...[...flight].filter(([key]) => !live.has(key)).map(([, entry]) => entry.issue),
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const phaseOf = (key: string): SendPhase | null =>
    heldKeys.has(key) ? "held" : (flight.get(key)?.phase ?? null);
  const answer = (issue: ProjectIssue, key: string, pick: DecisionPick, readNote: () => string) =>
    actions.run(key, `Answered: ${pickText(pick)}`, async () => {
      const input = decisionAnswerInput(pick, readNote());
      if (!input) return false;
      setPhase(key, { phase: "sending", issue });
      const sent = await decide(issue, input.decision, {
        ...(input.option ? { option: input.option } : {}),
        ...(input.answer ? { answer: input.answer } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (!sent) {
        setPhase(key, null);
        return false;
      }
      setPhase(key, { phase: "sent", issue });
      setTimeout(() => setPhase(key, null), SENT_LINGER_MS);
      return true;
    });
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Decisions
        <span className="tabular-nums text-foreground/60">{shown.length}</span>
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing waiting on you.</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((issue) => {
            const decision = issue.decision!;
            const key = issueKey(issue);
            return (
              <li key={key} className="flex items-start gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm">{issue.title}</span>
                  {decision.context ? (
                    <span className="mt-1 line-clamp-3 block text-sm text-foreground/85">
                      {decision.context}
                    </span>
                  ) : null}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {decision.waiting} · {formatIssueAge(issue.createdAt, now)} ·{" "}
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      #{issue.number}
                    </a>
                  </span>
                </span>
                <DecisionAnswer
                  decision={decision}
                  phase={phaseOf(key)}
                  onAnswer={(pick, readNote) => answer(issue, key, pick, readNote)}
                  onUndo={() => actions.undo(key)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
