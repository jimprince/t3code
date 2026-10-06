import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { OrchestratorBoard } from "../components/orchestrators/OrchestratorBoard";

function OrchestratorRoute() {
  const { environmentId, threadId } = Route.useParams();
  return (
    <OrchestratorBoard
      environmentId={environmentId as EnvironmentId}
      threadId={threadId as ThreadId}
    />
  );
}

export const Route = createFileRoute("/_chat/orchestrators/$environmentId/$threadId")({
  component: OrchestratorRoute,
});
