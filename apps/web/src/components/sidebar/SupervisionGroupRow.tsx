import { ChevronDownIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { SIDEBAR_NESTED_INDENT_PX } from "../Sidebar.drag";

export function SupervisionGroupRow(props: {
  label: string;
  kind: "quiet" | "burst";
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className="list-none"
      style={{ paddingInlineStart: props.depth * SIDEBAR_NESTED_INDENT_PX }}
    >
      <button
        type="button"
        data-testid={`sidebar-nested-${props.kind === "burst" ? "burst" : "done"}-group`}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/70 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0", !props.expanded && "-rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
      </button>
    </li>
  );
}
