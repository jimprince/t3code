import { createFileRoute } from "@tanstack/react-router";

import { EmbeddedPageView } from "../components/embeddedPages/EmbeddedPageView";

function EmbeddedPageRoute() {
  const { pageId } = Route.useParams();
  return <EmbeddedPageView pageId={pageId} />;
}

export const Route = createFileRoute("/embedded/$pageId")({
  component: EmbeddedPageRoute,
});
