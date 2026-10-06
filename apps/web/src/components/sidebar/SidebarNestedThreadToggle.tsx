import { ChevronDownIcon } from "lucide-react";
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
      aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.count} workers`}
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
