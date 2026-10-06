import { createFileRoute } from "@tanstack/react-router";

import { EmbeddedPageView } from "../components/embeddedPages/EmbeddedPageView";

function EmbeddedPageRoute() {
  const { pageId } = Route.useParams();
  const search = Route.useSearch();
  return <EmbeddedPageView pageId={pageId} issueTarget={search} />;
}

export const Route = createFileRoute("/embedded/$pageId")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.repo === "string" ? { repo: search.repo } : {}),
    ...(typeof search.issue === "string" ? { issue: search.issue } : {}),
  }),
  component: EmbeddedPageRoute,
});
