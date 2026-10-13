import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { Button, InlineButton } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { DecisionMarkdown } from "../orchestrators/DecisionMarkdown";
import { useDashboardUi, type DecisionRow } from "./context";
import { formatDeadline } from "./dashboard.logic";
import { answerMode } from "./useDecisionAnswers";

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
    if (threadId)
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(row.scoped.environmentId, threadId)),
      });
  };
}

/**
 * One decision: what it is, what it blocks, and the buttons to answer it right here through the
 * existing decision services. After an answer the card shows what happened, with Undo while held.
 * `full` adds the whole question; the feed shows its lead only.
 */
export function DecisionCard({
  row,
  full = false,
}: {
  readonly row: DecisionRow;
  readonly full?: boolean;
}) {
  const ui = useDashboardUi();
  const { answers } = ui;
  const openSource = useOpenDecisionSource();
  const { attention, scoped } = row;
  const state = answers.stateOf(row.key);
  const mode = answerMode(row);
  const told = scoped.project.title;

  if (state) {
    const record = state.kind === "record" ? state.record : null;
    const strip = answers.strip(state.kind === "held" ? "held" : state.record.delivery, told);
    const failed = record?.delivery.phase === "failed";
    return (
      <div className="py-1.5">
        <div className="flex items-baseline gap-2">
          {failed ? (
            <span className="text-destructive-foreground">!</span>
          ) : (
            <CheckIcon className="size-3.5 shrink-0 translate-y-0.5 text-success" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{attention.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 pl-5 text-xs text-muted-foreground">
          <span>
            {state.kind === "held" ? state.label : (record?.label ?? "")} · {strip.text}
          </span>
          {state.kind === "held" ? (
            <InlineButton tone="muted" onClick={state.undo}>
              Undo
            </InlineButton>
          ) : record?.retry ? (
            <InlineButton tone="muted" onClick={record.retry}>
              Retry
            </InlineButton>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-2xs whitespace-nowrap text-warning-foreground">
          {attention.deadline
            ? `by ${formatDeadline(attention.deadline, ui.now)}`
            : KIND_WORD[attention.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{attention.title}</span>
      </div>
      <div className="text-xs text-muted-foreground">{consequence(row)}</div>
      {full ? (
        <div className="my-1.5">
          <DecisionMarkdown
            environmentId={scoped.environmentId}
            markdown={attention.question}
            issueUrl={attention.url ?? "https://localhost/"}
            clamp={12}
          />
        </div>
      ) : lead(attention.question) ? (
        <div className="line-clamp-2 text-xs">{lead(attention.question)}</div>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {mode === "option"
          ? attention.options.map((option) => (
              <Tooltip key={option.text}>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm-multiline"
                      variant={option.recommended ? "default" : "outline"}
                      className="max-w-full"
                      onClick={() => answers.answerOption(row, option.text)}
                    />
                  }
                >
                  <span className="line-clamp-2 min-w-0 text-left break-words">{option.text}</span>
                </TooltipTrigger>
                <TooltipPopup>{option.text}</TooltipPopup>
              </Tooltip>
            ))
          : null}
        {mode === "approval" ? (
          <>
            <Button size="xs" onClick={() => answers.respond(row, "accept", "Approved")}>
              Approve
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => answers.respond(row, "decline", "Declined")}
            >
              Decline
            </Button>
          </>
        ) : null}
        <Button size="xs" variant="ghost-muted" onClick={() => openSource(row)}>
          {mode === "open" ? "Open" : "Open task"}
        </Button>
      </div>
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
