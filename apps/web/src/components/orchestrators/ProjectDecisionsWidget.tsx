import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { deriveDecisions } from "./decisions.logic";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { issueKey } from "./projectRequests.logic";
import {
  UndoLines,
  useDecide,
  useProjectRequests,
  useUndoableActions,
} from "./ProjectRequestsSection";

type Pick = { readonly option: string } | { readonly answer: string };

/** One decision's buttons (or answer box for an open question) and optional note. */
function DecisionAnswer({
  decision,
  onAnswer,
}: {
  readonly decision: NonNullable<ProjectIssue["decision"]>;
  readonly onAnswer: (pick: Pick, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const send = () => text.trim() && onAnswer({ answer: text.trim() }, note.trim());
  return (
    <span className="flex w-60 shrink-0 flex-col gap-1">
      {decision.options.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {decision.options.map((option) => (
            <Button
              key={option.text}
              size="sm-multiline"
              variant={option.recommended ? "default" : "outline"}
              className="max-w-full text-left"
              onClick={() => onAnswer({ option: option.text }, note.trim())}
            >
              {option.text}
              {option.recommended ? (
                <span className="text-xs font-normal opacity-70">recommended</span>
              ) : null}
            </Button>
          ))}
        </span>
      ) : (
        <span className="flex gap-1">
          <Input
            size="sm"
            value={text}
            maxLength={2000}
            placeholder="Answer"
            aria-label="Answer"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") send();
            }}
          />
          <Button size="xs" variant="outline" disabled={!text.trim()} onClick={send}>
            <SendIcon />
            Send
          </Button>
        </span>
      )}
      <Input
        size="sm"
        value={note}
        maxLength={500}
        placeholder="Note (optional)"
        aria-label="Note"
        onChange={(event) => setNote(event.target.value)}
      />
    </span>
  );
}

/**
 * Decisions waiting on Brad: open `needs-brad` issues in the fixed decision format.
 * One click answers (with an optional note); the answer is held for a few seconds
 * with Undo, then commented on the issue and sent to the waiting thread.
 */
export function ProjectDecisionsWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, now } = useProjectRequests(summary);
  const actions = useUndoableActions();
  const decide = useDecide(summary, query.refresh);
  const decisions = useMemo(() => deriveDecisions(query.data?.issues ?? []), [query.data]);
  const shown = decisions.filter((issue) => !actions.isGone(issueKey(issue)));
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
                  onAnswer={(pick, note) =>
                    actions.run(
                      key,
                      "option" in pick ? `Chose: ${pick.option}` : `Answered: ${pick.answer}`,
                      () =>
                        decide(issue, "option" in pick ? "option" : "answer", {
                          ...pick,
                          ...(note ? { reason: note } : {}),
                        }),
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      <UndoLines actions={actions} />
    </section>
  );
}
