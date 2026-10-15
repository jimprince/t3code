import { createFileRoute } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

import { SubheadPage } from "../components/harness/SubheadPage";

/** One virtual subhead in the main pane, opened from its row under its head in the Harness list. */
function SubheadRoute() {
  const { environmentId, name } = Route.useParams();
  return <SubheadPage environmentId={environmentId as EnvironmentId} name={name} />;
}

export const Route = createFileRoute("/_chat/harness/subheads/$environmentId/$name")({
  component: SubheadRoute,
});
