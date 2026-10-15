import { buildOrchestratorSummaries } from "@t3tools/client-runtime/state/orchestrators";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjects } from "../../state/entities";
import { ProjectRequestBox, REQUEST_QUICK_ACTIONS } from "../orchestrators/ProjectRequestBox";
import { useOrchestratorThreadShells } from "../orchestrators/useOrchestratorThreads";
import { useDashboardUi } from "./context";
import { topLevelProjects } from "./dashboard.logic";
import { useSectionMarker } from "./parts";
import { NoticeLine, RequestLine } from "./RequestLine";

const COS_TITLE = /chief of staff/i;

/**
 * Ask first (R11). On a server that stores the order, the one-line request line files typed items
 * straight into the project's tracker (the picked project on Home, the page's own project head on a
 * project page); Home's picker also offers the Chief of Staff, which sends as the old box did. A
 * project with no Gitea tracker, and an older server, keep the existing request box, routed to the
 * Chief of Staff on Home. It reads the thread shells itself so a shell change re-renders only this box, not the
 * whole Dashboard.
 */
export function AskSection({
  projectHead,
}: {
  /** The project page's head thread; null on Home. */
  readonly projectHead: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } | null;
}) {
  const ui = useDashboardUi();
  const marker = useSectionMarker("ask");
  const projects = useProjects();
  const threads = useOrchestratorThreadShells();
  const fileable = projectHead
    ? ui.root !== null && ui.order.canFile(ui.root)
    : topLevelProjects(ui.data.projects).products.some((scoped) => ui.order.canFile(scoped));
  const summary = useMemo(() => {
    const summaries = buildOrchestratorSummaries(threads, projects);
    return projectHead
      ? (summaries.find(
          (entry) =>
            entry.root.environmentId === projectHead.environmentId &&
            entry.root.id === projectHead.threadId,
        ) ?? null)
      : (summaries.find((entry) => COS_TITLE.test(entry.root.title)) ?? null);
  }, [projectHead, projects, threads]);
  if (fileable)
    return (
      <div {...marker}>
        <RequestLine
          projectHead={projectHead ? ui.root : null}
          chief={projectHead ? null : summary}
        />
        <NoticeLine />
      </div>
    );
  if (!summary) return <div {...marker} hidden />;
  return (
    <div {...marker}>
      <ProjectRequestBox
        summary={summary}
        quickActions={REQUEST_QUICK_ACTIONS}
        prefill={ui.prefill}
        placeholder={`New request to ${summary.root.title}`}
      />
    </div>
  );
}
