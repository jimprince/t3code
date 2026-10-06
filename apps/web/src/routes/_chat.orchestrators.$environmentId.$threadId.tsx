import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { OrchestratorBoard } from "../components/orchestrators/OrchestratorBoard";
import { isProjectTab, type ProjectTab } from "../components/orchestrators/projectTabs.logic";
import { encodeTaskRef, parseTaskRef } from "../components/orchestrators/taskView.logic";

export interface OrchestratorSearch {
  /** The project layout tab id; absent means the tab this device last used for the project. */
  readonly tab?: ProjectTab;
  /** The task open in the side panel, as host/owner/repo#N; absent means no panel. */
  readonly task?: string;
}

function OrchestratorRoute() {
  const { environmentId, threadId } = Route.useParams();
  const { tab, task } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OrchestratorBoard
      environmentId={environmentId as EnvironmentId}
      threadId={threadId as ThreadId}
      tab={tab ?? null}
      // A tab change is a history entry, so Back returns to the previous tab.
      onTabChange={(next) => void navigate({ search: { tab: next } })}
      task={task ? parseTaskRef(task) : null}
      // Opening a task is a history entry too, so Back closes the panel.
      onTaskChange={(ref) =>
        void navigate({
          search: ({ task: _closed, ...rest }) =>
            ref ? { ...rest, task: encodeTaskRef(ref) } : rest,
        })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/orchestrators/$environmentId/$threadId")({
  validateSearch: (raw: Record<string, unknown>): OrchestratorSearch => ({
    ...(isProjectTab(raw.tab) ? { tab: raw.tab } : {}),
    ...(typeof raw.task === "string" && parseTaskRef(raw.task) ? { task: raw.task } : {}),
  }),
  component: OrchestratorRoute,
});
