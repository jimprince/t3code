import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type { Ref } from "react";

import { cn } from "../../lib/utils";
import { InlineButton } from "../ui/button";
import { formatLastReply, waitingLabel } from "./cosTray.logic";

/** Static dot: amber while decisions wait on Brad, blue while the desk is replying, else quiet. */
export function CosDot({
  waiting,
  replying,
  className,
}: {
  readonly waiting: number;
  readonly replying: boolean;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        waiting > 0 ? "bg-warning" : replying ? "bg-info" : "bg-muted-foreground/40",
        className,
      )}
    />
  );
}

/** "3 waiting on you" in amber, and "last reply 13:55" when the desk has replied. */
export function CosSummaryLine({
  waiting,
  lastReplyAt,
  decisionsOpen,
  decisionsId,
  toggleRef,
  onToggleDecisions,
}: {
  readonly waiting: number;
  readonly lastReplyAt: string | null;
  readonly decisionsOpen: boolean;
  readonly decisionsId: string;
  readonly toggleRef: Ref<HTMLButtonElement>;
  readonly onToggleDecisions: () => void;
}) {
  const lastReply = lastReplyAt ? formatLastReply(lastReplyAt) : "";
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      {waiting > 0 ? (
        <InlineButton
          ref={toggleRef}
          aria-expanded={decisionsOpen}
          aria-controls={decisionsId}
          onClick={onToggleDecisions}
        >
          {waitingLabel(waiting)}
          {decisionsOpen ? (
            <ChevronUpIcon className="size-3" />
          ) : (
            <ChevronDownIcon className="size-3" />
          )}
        </InlineButton>
      ) : (
        <span className="text-muted-foreground">Nothing waiting on you</span>
      )}
      {lastReply ? <span className="text-muted-foreground">last reply {lastReply}</span> : null}
    </div>
  );
}
