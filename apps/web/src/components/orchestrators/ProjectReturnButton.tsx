import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { buildOrchestratorSummaries } from "@t3tools/client-runtime/state/orchestrators";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";

import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { owningProjectReturn, type ProjectReturnLocation } from "./projectNavigation";
import { useOrchestratorThreadShells } from "./useOrchestratorThreads";

function BackButton({ project }: { readonly project: ProjectReturnLocation }) {
  const navigate = useNavigate();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Back to project"
      onClick={() =>
        void navigate({ to: "/orchestrators/$environmentId/$threadId", params: project })
      }
    >
      <ArrowLeftIcon />
    </Button>
  );
}

/** Only mounted for a thread with no recorded return, so other thread views never subscribe to every shell. */
function OwningProjectBackButton({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projects = useProjects();
  const threads = useOrchestratorThreadShells();
  const project = useMemo(
    () =>
      owningProjectReturn(buildOrchestratorSummaries(threads, projects), environmentId, threadId),
    [environmentId, projects, threadId, threads],
  );
  return project ? <BackButton project={project} /> : null;
}

/**
 * "Back to project" in a thread's header. Opening a thread from the project page records
 * the page in history; a thread loaded directly (bookmark, reload, shared link) has no
 * such record, so the project that owns it is looked up instead. Standalone threads get none.
 */
export function ProjectReturnButton({
  environmentId,
  threadId,
  recorded,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly recorded: ProjectReturnLocation | undefined;
}) {
  return recorded ? (
    <BackButton project={recorded} />
  ) : (
    <OwningProjectBackButton environmentId={environmentId} threadId={threadId} />
  );
}
