import { ChevronDownIcon, MessageCircleQuestionIcon } from "lucide-react";
import { cn } from "~/lib/utils";

export function SidebarNestedThreadToggle(props: {
  count: number;
  activeCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.count} sub-agents`}
      aria-expanded={props.expanded}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-secondary-label outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronDownIcon aria-hidden className={cn("size-3", !props.expanded && "-rotate-90")} />
      {`${props.activeCount} active`}
    </button>
  );
}

export function SidebarNestedInputAttention(props: {
  inputCount: number;
  onOpenInput?: () => void;
}) {
  const label =
    props.inputCount === 1
      ? "1 sub-agent needs input"
      : `${props.inputCount} sub-agents need input`;
  return (
    <button
      type="button"
      aria-label={`Open ${label}`}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpenInput?.();
      }}
      className="inline-flex min-w-0 shrink-0 items-center gap-1 rounded-sm text-xs text-info outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <MessageCircleQuestionIcon aria-hidden className="size-3 shrink-0" />
      {label}
    </button>
  );
}
