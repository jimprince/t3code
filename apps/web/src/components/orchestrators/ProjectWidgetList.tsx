import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectCanvasPage } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { projectCanvasQuery } from "../../state/projectCanvas";
import {
  projectDashboardQuery,
  setProjectDashboardTracker,
  setProjectDashboardWidgets,
} from "../../state/projectDashboard";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ProjectCanvasError, ProjectCanvasWidget } from "./ProjectCanvasWidget";
import { requestsByWorker } from "./projectRequests.logic";
import { useProjectRequests } from "./ProjectRequestsSection";
import {
  canvasWidgetId,
  isCanvasWidget,
  moveChoice,
  savedOrder,
  visibleWidgets,
  widgetChoices,
  type CanvasWidgetId,
  type DashboardWidgetId,
  type ProjectWidgetId,
  type WidgetChoice,
} from "./projectWidgets.logic";

/** Consecutive canvases share a grid row by size; every other widget stands alone. */
function groupCanvases(order: ReadonlyArray<DashboardWidgetId>) {
  const groups: Array<ReadonlyArray<DashboardWidgetId>> = [];
  for (const id of order) {
    const last = groups.at(-1);
    if (last && isCanvasWidget(id) && isCanvasWidget(last[0]!)) {
      groups[groups.length - 1] = [...last, id];
    } else {
      groups.push([id]);
    }
  }
  return groups;
}

/** "for: <request>" under a worker row: which of Brad's asks the worker serves. */
export function WorkerRequestTag({
  summary,
  threadId,
}: {
  readonly summary: OrchestratorSummary;
  readonly threadId: string;
}) {
  const { requests } = useProjectRequests(summary);
  const served = useMemo(
    () => requestsByWorker(requests).get(threadId) ?? [],
    [requests, threadId],
  );
  if (served.length === 0) return null;
  return (
    <span className="mt-0.5 block truncate text-xs text-foreground/80">
      for: {served.map((request) => request.issue.title).join(" · ")}
    </span>
  );
}

/**
 * The project page body: the project's widgets in its saved order (server-side,
 * shared with the orchestrator's `t3-thread dashboard set`), and the Customize
 * dialog that changes the order, visibility and the Gitea tracker repository.
 */
export function ProjectWidgetList({
  summary,
  views,
  customizing,
  onCustomizingChange,
}: {
  readonly summary: OrchestratorSummary;
  readonly views: Partial<Record<ProjectWidgetId, ReactNode>>;
  /** The Customize dialog, opened from the tab row. */
  readonly customizing: boolean;
  readonly onCustomizingChange: (open: boolean) => void;
}) {
  const environmentId = summary.root.environmentId;
  const dashboard = useEnvironmentQuery(
    projectDashboardQuery({ environmentId, input: { threadId: summary.root.id } }),
  );
  const saveWidgets = useAtomCommand(setProjectDashboardWidgets, "Save widgets");
  const saveTracker = useAtomCommand(setProjectDashboardTracker, "Save tracker repository");
  const canvas = useEnvironmentQuery(
    projectCanvasQuery({ environmentId, input: { threadId: summary.root.id } }),
  );
  const canvasPages = useMemo(
    () =>
      new Map<string, ProjectCanvasPage>(
        (canvas.data?.canvases ?? []).map((page) => [canvasWidgetId(page.id), page]),
      ),
    [canvas.data],
  );
  const canvasInfo = useMemo(
    () => [...canvasPages].map(([id, page]) => ({ id: id as CanvasWidgetId, title: page.title })),
    [canvasPages],
  );
  const canvasNow = canvas.dataUpdatedAt ?? 0;
  const saved = dashboard.data?.widgets ?? null;
  const order = visibleWidgets(saved, canvasInfo);
  const [choices, setChoices] = useState<WidgetChoice[]>([]);
  const [tracker, setTracker] = useState("");
  // Start the dialog from the saved settings each time it opens.
  const [openedWith, setOpenedWith] = useState(false);
  if (customizing !== openedWith) {
    setOpenedWith(customizing);
    if (customizing) {
      setChoices(widgetChoices(saved, canvasInfo));
      setTracker(dashboard.data?.tracker ?? "");
    }
  }
  const save = async () => {
    const widgets = await saveWidgets({
      environmentId,
      input: { threadId: summary.root.id, widgets: savedOrder(choices) },
    });
    const nextTracker = tracker.trim() || null;
    const trackerResult =
      nextTracker === (dashboard.data?.tracker ?? null)
        ? null
        : await saveTracker({
            environmentId,
            input: { threadId: summary.root.id, tracker: nextTracker },
          });
    dashboard.refresh();
    if (widgets._tag === "Success" && trackerResult?._tag !== "Failure") {
      onCustomizingChange(false);
    }
  };

  return (
    <>
      {groupCanvases(order).map((group) => {
        if (!isCanvasWidget(group[0]!)) {
          const id = group[0] as ProjectWidgetId;
          return (
            <Fragment key={id}>
              {id === "canvas" && canvas.data ? <ProjectCanvasError canvas={canvas.data} /> : null}
              {views[id] ?? null}
            </Fragment>
          );
        }
        return (
          <div key={group.join(",")} className="grid grid-cols-6 gap-4 border-t border-border pt-4">
            {group.map((id) => {
              const page = canvasPages.get(id);
              return page ? (
                <ProjectCanvasWidget key={id} summary={summary} canvas={page} now={canvasNow} />
              ) : null;
            })}
          </div>
        );
      })}
      <Dialog open={customizing} onOpenChange={onCustomizingChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Customize project page</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-2">
            <ul className="flex flex-col">
              {choices.map((choice, index) => (
                <li key={choice.id} className="flex items-center gap-2 py-1 text-sm">
                  <Checkbox
                    aria-label={`Show ${choice.title}`}
                    checked={choice.visible}
                    onCheckedChange={(checked) =>
                      setChoices((current) =>
                        current.map((item) =>
                          item.id === choice.id ? { ...item, visible: checked === true } : item,
                        ),
                      )
                    }
                  />
                  <span className={`flex-1 ${choice.visible ? "" : "text-muted-foreground"}`}>
                    {choice.title}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${choice.title} up`}
                    disabled={index === 0}
                    onClick={() => setChoices((current) => moveChoice(current, index, -1))}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${choice.title} down`}
                    disabled={index === choices.length - 1}
                    onClick={() => setChoices((current) => moveChoice(current, index, 1))}
                  >
                    <ArrowDownIcon />
                  </Button>
                </li>
              ))}
            </ul>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Gitea tracker repository
              <Input
                value={tracker}
                placeholder="owner/repo, when the code is not on Gitea"
                onChange={(event) => setTracker(event.target.value)}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onCustomizingChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
