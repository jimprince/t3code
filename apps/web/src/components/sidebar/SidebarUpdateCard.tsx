import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Button } from "../ui/button";
import { confirmAndStartDesktopUpdate, useDesktopUpdateFlow } from "./desktopUpdateFlow";
import { resolveDesktopUpdateProgress, UPDATE_STEP_COUNT } from "./desktopUpdateProgress.logic";

/** Five discrete segments; the failed step is tinted. */
function StepBar({ step, failed }: { readonly step: number; readonly failed: boolean }) {
  return (
    <div aria-hidden className="flex gap-1">
      {Array.from({ length: UPDATE_STEP_COUNT }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-1 flex-1 rounded-full",
            index + 1 > step
              ? "bg-sidebar-row-hover"
              : failed && index + 1 === step
                ? "bg-error"
                : "bg-sidebar-foreground",
          )}
        />
      ))}
    </div>
  );
}

/**
 * Progress of the one-click desktop update, in the sidebar footer: which of the five steps is
 * running, or why it stopped, with Retry and Dismiss. Updates that never came from the pill stay in the pill.
 */
export function SidebarUpdateCard() {
  return isElectron ? <SidebarUpdateCardContent /> : null;
}

function SidebarUpdateCardContent() {
  const state = useDesktopUpdateState();
  const flow = useDesktopUpdateFlow((store) => store.flow);
  const progress = resolveDesktopUpdateProgress(state, flow);
  if (progress === null) return null;

  // Retrying asks the same "agents will be interrupted" question as the first click.
  const retry = () => {
    const startUpdate = window.desktopBridge?.startUpdate;
    if (!startUpdate || !state) return;
    void confirmAndStartDesktopUpdate(startUpdate.bind(window.desktopBridge), state);
  };
  const dismiss = () => useDesktopUpdateFlow.setState({ flow: "idle" });

  if (progress.kind === "failed") {
    return (
      <div
        role="alert"
        className="flex flex-col gap-1.5 rounded-lg border border-error/30 bg-error-surface px-3 py-2 text-xs"
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-sidebar-foreground">{progress.title}</span>
          <div className="ml-auto flex gap-1">
            {progress.canRetry && window.desktopBridge?.startUpdate ? (
              <Button size="xs" variant="outline" onClick={retry}>
                Retry
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </div>
        <StepBar step={progress.step} failed />
        <p className="text-error-foreground">{progress.reason}</p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-lg border border-sidebar-border bg-sidebar-control-surface px-3 py-2 text-xs"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-sidebar-foreground">{progress.title}</span>
        <span className="ml-auto tabular-nums text-sidebar-muted-foreground">
          {progress.step} of {UPDATE_STEP_COUNT}
        </span>
      </div>
      <StepBar step={progress.step} failed={false} />
      <p className="text-sidebar-foreground">
        {progress.label}
        {progress.detail ? (
          <span className="text-sidebar-muted-foreground"> · {progress.detail}</span>
        ) : null}
      </p>
    </div>
  );
}
