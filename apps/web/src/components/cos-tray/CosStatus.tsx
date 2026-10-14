import { cn } from "../../lib/utils";
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
}: {
  readonly waiting: number;
  readonly lastReplyAt: string | null;
}) {
  const lastReply = lastReplyAt ? formatLastReply(lastReplyAt) : "";
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className={waiting > 0 ? "text-warning-foreground" : "text-muted-foreground"}>
        {waiting > 0 ? waitingLabel(waiting) : "Nothing waiting on you"}
      </span>
      {lastReply ? <span className="text-muted-foreground">last reply {lastReply}</span> : null}
    </div>
  );
}
