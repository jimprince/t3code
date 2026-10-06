import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { ArrowDownIcon, ArrowUpIcon, SlidersHorizontalIcon } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";

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
import { requestsByWorker } from "./projectRequests.logic";
import { useProjectRequests } from "./ProjectRequestsSection";
import {
  moveChoice,
  savedOrder,
  visibleWidgets,
  widgetChoices,
  type ProjectWidgetId,
  type WidgetChoice,
} from "./projectWidgets.logic";

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
}: {
  readonly summary: OrchestratorSummary;
  readonly views: Partial<Record<ProjectWidgetId, ReactNode>>;
}) {
  const environmentId = summary.root.environmentId;
  const dashboard = useEnvironmentQuery(
    projectDashboardQuery({ environmentId, input: { threadId: summary.root.id } }),
  );
  const saveWidgets = useAtomCommand(setProjectDashboardWidgets, "Save widgets");
  const saveTracker = useAtomCommand(setProjectDashboardTracker, "Save tracker repository");
  const saved = dashboard.data?.widgets ?? null;
  const order = visibleWidgets(saved);
  const [editing, setEditing] = useState(false);
  const [choices, setChoices] = useState<WidgetChoice[]>([]);
  const [tracker, setTracker] = useState("");

  const open = () => {
    setChoices(widgetChoices(saved));
    setTracker(dashboard.data?.tracker ?? "");
    setEditing(true);
  };
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
    if (widgets._tag === "Success" && trackerResult?._tag !== "Failure") setEditing(false);
  };

  return (
    <>
      <div className="-mb-3 flex justify-end">
        <Button size="xs" variant="ghost-muted" onClick={open}>
          <SlidersHorizontalIcon />
          Customize
        </Button>
      </div>
      {order.map((id) => (
        <Fragment key={id}>{views[id] ?? null}</Fragment>
      ))}
      <Dialog open={editing} onOpenChange={setEditing}>
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
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
