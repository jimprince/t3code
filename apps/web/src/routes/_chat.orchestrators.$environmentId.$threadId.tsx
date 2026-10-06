import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { OrchestratorBoard } from "../components/orchestrators/OrchestratorBoard";
import { isProjectTab, type ProjectTab } from "../components/orchestrators/projectTabs.logic";

export interface OrchestratorSearch {
  /** The project layout tab id; absent means the tab this device last used for the project. */
  readonly tab?: ProjectTab;
}

function OrchestratorRoute() {
  const { environmentId, threadId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OrchestratorBoard
      environmentId={environmentId as EnvironmentId}
      threadId={threadId as ThreadId}
      tab={tab ?? null}
      // A tab change is a history entry, so Back returns to the previous tab.
      onTabChange={(next) => void navigate({ search: { tab: next } })}
    />
  );
}

export const Route = createFileRoute("/_chat/orchestrators/$environmentId/$threadId")({
  validateSearch: (raw: Record<string, unknown>): OrchestratorSearch =>
    isProjectTab(raw.tab) ? { tab: raw.tab } : {},
  component: OrchestratorRoute,
});
