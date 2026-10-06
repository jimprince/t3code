import type { ReactNode } from "react";
import type { SupervisionGroup } from "./nestedThreadVisibility.logic";

export function SupervisionGroupRow(props: {
  group: SupervisionGroup;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
        className="w-full px-2 py-1 text-left text-xs"
      >
        {props.group.children.length}{" "}
        {props.group.kind === "burst" ? "created together" : "quiet threads"}
      </button>
      {props.expanded ? props.children : null}
    </div>
  );
}
