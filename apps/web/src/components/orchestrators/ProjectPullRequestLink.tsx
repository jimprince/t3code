import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { InlineButton } from "../ui/button";
import { projectReturnState } from "./projectNavigation";

export function ProjectPullRequestLink({
  summary,
  pullRequest,
}: {
  readonly summary: OrchestratorSummary;
  readonly pullRequest: ThreadPullRequestLink;
}) {
  const navigate = useNavigate();
  return (
    <InlineButton
      onClick={() =>
        void navigate({
          to: "/pull-requests",
          search: {
            ...readPullRequestListPreferences(),
            repository: pullRequest.repository,
            number: pullRequest.number,
            selectedHost: pullRequest.host,
          },
          state: projectReturnState({
            environmentId: summary.root.environmentId,
            threadId: summary.root.id,
          }),
        })
      }
    >
      <PullRequestGlyph.pullRequest className="size-3.5" />
      {pullRequest.repository.split("/").at(-1)}#{pullRequest.number}
    </InlineButton>
  );
}
