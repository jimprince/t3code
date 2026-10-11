import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  taskProgress,
  taskProgressComplete,
  taskProgressDescription,
  taskProgressFraction,
} from "@t3tools/client-runtime/state/projectSubprojects";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * "24/36" tasks done for a project or subproject row, with "24 of 36 tasks done" as its tooltip
 * and screen-reader text. Renders nothing without tasks and dims once every task is done. It
 * takes pointer events itself so the tooltip shows on rows whose content lets clicks fall
 * through to an overlay button.
 */
export function TaskFraction({
  summary,
  className,
}: {
  readonly summary: OrchestratorSummary;
  readonly className?: string;
}) {
  const progress = taskProgress(summary);
  const fraction = taskProgressFraction(progress);
  const description = taskProgressDescription(progress);
  if (fraction === null || description === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={description}
            className={cn(
              "pointer-events-auto shrink-0 tabular-nums",
              taskProgressComplete(progress) && "opacity-50",
              className,
            )}
          />
        }
      >
        {fraction}
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}

/** The one collapsed row that holds a project's settled subprojects: "Settled (2)". */
export function SettledSubprojectsToggle({
  count,
  expanded,
  onToggle,
  className,
  style,
}: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} ${count} settled ${count === 1 ? "subproject" : "subprojects"}`}
      className={cn(
        "pointer-events-auto flex cursor-pointer items-center gap-1 text-left hover:text-sidebar-foreground",
        className,
      )}
      style={style}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDownIcon aria-hidden className="size-3" />
      ) : (
        <ChevronRightIcon aria-hidden className="size-3" />
      )}
      <span>Settled ({count})</span>
    </button>
  );
}
