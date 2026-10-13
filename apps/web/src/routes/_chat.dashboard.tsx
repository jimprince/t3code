import { createFileRoute } from "@tanstack/react-router";

import { DashboardView } from "../components/dashboard-v3/DashboardView";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

/** Home: every connected environment's projects on one page, with what needs a decision. */
function HomeDashboardRoute() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <h1 className="truncate text-sm font-medium">Home</h1>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade min-h-0 min-w-0 flex-1 overflow-y-auto border-t border-border">
          <WorkspacePageContainer width="wide" className="gap-3">
            <DashboardView scope={{ kind: "home" }} />
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/dashboard")({
  component: HomeDashboardRoute,
});
