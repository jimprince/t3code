import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  CircleIcon,
  CirclePauseIcon,
  PanelLeftIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadNestingActions } from "../../hooks/useThreadNesting";
import { cn } from "../../lib/utils";
import { useProjects, useServerConfigs } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  supervisionWorkerDuration,
  supervisionWorkerMetadata,
  supervisionWorkerOutput,
  supervisionWorkerStatus,
  type SupervisionWorkerStatus,
} from "./supervisionWorkerRow.logic";

const WORKER_STATUS: Record<
  SupervisionWorkerStatus,
  { label: string; Icon: typeof CircleIcon; className: string }
> = {
  working: { label: "Working", Icon: CircleIcon, className: "text-info" },
  input: { label: "Needs input", Icon: CircleHelpIcon, className: "text-info" },
  approval: { label: "Approval", Icon: ShieldQuestionIcon, className: "text-warning" },
  completed: { label: "Completed", Icon: CheckIcon, className: "text-success" },
  error: { label: "Error", Icon: CircleAlertIcon, className: "text-error" },
  settled: { label: "Settled", Icon: CheckIcon, className: "text-muted-foreground" },
  interrupted: { label: "Interrupted", Icon: CirclePauseIcon, className: "text-muted-foreground" },
  ready: { label: "Ready", Icon: CircleIcon, className: "text-muted-foreground" },
};

/** One organizational worker in the thread details panel: open it, or move it back to the sidebar. */
export function SupervisionWorkerRow(props: {
  child: EnvironmentThreadShell;
  parentProjectId: EnvironmentThreadShell["projectId"] | undefined;
}) {
  const { child } = props;
  const navigate = useNavigate();
  const configs = useServerConfigs();
  const projects = useProjects();
  const { setThreadParent } = useThreadNestingActions();
  const nowMinute = useNowMinute();
  const status = WORKER_STATUS[supervisionWorkerStatus(child)];
  const providerId = child.runtime?.providerInstanceId ?? child.providerInstanceId;
  const providerName = configs
    .get(child.environmentId)
    ?.providers.find((entry) => entry.instanceId === providerId)?.displayName;
  const project =
    child.projectId === props.parentProjectId
      ? undefined
      : projects.find(
          (entry) => entry.environmentId === child.environmentId && entry.id === child.projectId,
        );
  const output = supervisionWorkerOutput(child, status.label);
  const duration = supervisionWorkerDuration(child, `${nowMinute}:00Z`);
  return (
    <div className="flex items-center gap-1 rounded-md hover:bg-accent/40">
      <button
        type="button"
        onClick={() => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(child.environmentId, child.id)),
          });
        }}
        className="grid min-w-0 flex-1 grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-x-2 px-1.5 py-1 text-left"
      >
        <status.Icon
          aria-label={status.label}
          className={cn("col-start-1 size-3 shrink-0", status.className)}
        />
        <span className="col-start-2 flex min-w-0 items-baseline gap-2 text-sm font-medium">
          <span className="min-w-0 truncate">{child.title}</span>
          {project ? <span className="shrink-0 truncate text-xs">{project.title}</span> : null}
        </span>
        <span className="col-start-3 font-mono text-2xs">
          {duration ? `${duration} · ` : ""}
          {status.label}
        </span>
        <span className="col-start-2 col-end-4 truncate text-xs">{output}</span>
        <Tooltip>
          <TooltipTrigger
            render={<span className="col-start-2 col-end-4 truncate font-mono text-2xs" />}
          >
            {supervisionWorkerMetadata(child, providerName, false)}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {supervisionWorkerMetadata(child, providerName, true)}
          </TooltipPopup>
        </Tooltip>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={`Move ${child.title} to sidebar`}
              onClick={() => {
                void setThreadParent(scopeThreadRef(child.environmentId, child.id), null);
              }}
            />
          }
        >
          <PanelLeftIcon aria-hidden className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Move to sidebar</TooltipPopup>
      </Tooltip>
    </div>
  );
}
