import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationBriefThreadResult, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

type BriefState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly brief: OrchestrationBriefThreadResult }
  | { readonly status: "error"; readonly message: string };

const SECTIONS = [
  ["needsYou", "Needs you"],
  ["done", "Done"],
  ["moving", "Moving"],
  ["blocked", "Blocked"],
] as const;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Brief me: a one-shot summary of worker traffic since the user's last message.
 * Each open asks again; the summary is not stored and never reaches the
 * orchestrator's own context.
 */
export function ThreadBriefButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const briefThread = useAtomCommand(orchestrationEnvironment.briefThread, {
    reportFailure: false,
  });
  const [state, setState] = useState<BriefState>({ status: "idle" });

  const requestBrief = async () => {
    setState({ status: "loading" });
    const result = await briefThread({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    if (result._tag === "Success") {
      setState({ status: "ready", brief: result.value });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not brief this thread.",
      });
    }
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void requestBrief();
      }}
    >
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>Brief me</PopoverTrigger>
      <PopoverPopup align="end" width="lg" padding="compact" aria-label="Brief">
        <BriefBody state={state} />
      </PopoverPopup>
    </Popover>
  );
}

function BriefBody({ state }: { readonly state: BriefState }) {
  if (state.status === "idle" || state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Briefing from the latest turns.</p>;
  }
  if (state.status === "error") {
    // Provider failures can carry a whole CLI log; show its start and keep the rest on hover.
    return (
      <p
        className="line-clamp-4 break-words text-sm text-destructive-foreground"
        title={state.message}
      >
        {state.message}
      </p>
    );
  }
  const { brief } = state;
  const header = (
    <div className="mb-2 flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
      <span>
        {brief.turnCount} worker {brief.turnCount === 1 ? "turn" : "turns"} since your last message
      </span>
      <span>{timeFormat.format(new Date(brief.generatedAt))}</span>
    </div>
  );
  const sections = SECTIONS.filter(([key]) => brief[key].length > 0);
  if (sections.length === 0) {
    return (
      <div>
        {header}
        <p className="text-sm text-muted-foreground">Nothing new since your last message.</p>
      </div>
    );
  }
  return (
    <div>
      {header}
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        {sections.map(([key, label]) => (
          <div key={key} className="contents">
            <dt
              className={key === "needsYou" ? "text-warning-foreground" : "text-muted-foreground"}
            >
              {label}
            </dt>
            <dd>
              {brief[key].map((line) => (
                <p key={line}>{line}</p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
