import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { HarnessCheckPage } from "../components/harness/HarnessCheckPage";

/** One Harness check in the main pane; `checkKey` is the key its snapshot gives it. */
function HarnessCheckRoute() {
  const { environmentId, checkKey } = Route.useParams();
  const checkRef = useMemo(() => ({ environmentId, checkKey }), [checkKey, environmentId]);
  return <HarnessCheckPage checkRef={checkRef} />;
}

export const Route = createFileRoute("/_chat/harness/checks/$environmentId/$checkKey")({
  component: HarnessCheckRoute,
});
