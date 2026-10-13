import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  settledGroupSummary,
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
 * takes pointer events itself so the tooltip shows, which also keeps clicks from reaching a
 * row's overlay button: on such rows pass `onActivate` so a click on it opens the row too.
 */
export function TaskFraction({
  summary,
  className,
  onActivate,
}: {
  readonly summary: OrchestratorSummary;
  readonly className?: string;
  readonly onActivate?: () => void;
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
            onClick={onActivate}
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

/**
 * The one collapsed row that holds a project's settled subprojects: "Settled (2)", with a
 * warning count after it when any of them needs you or is blocked.
 */
export function SettledSubprojectsToggle({
  settled,
  expanded,
  onToggle,
  className,
  style,
}: {
  readonly settled: ReadonlyArray<OrchestratorSummary>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  const group = settledGroupSummary(settled);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} ${group.description}`}
      className={cn(
        "pointer-events-auto flex cursor-pointer items-center gap-1 text-left hover:text-sidebar-foreground",
        className,
        group.attention && "text-warning-foreground",
      )}
      style={style}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDownIcon aria-hidden className="size-3" />
      ) : (
        <ChevronRightIcon aria-hidden className="size-3" />
      )}
      <span>{group.label}</span>
    </button>
  );
}
