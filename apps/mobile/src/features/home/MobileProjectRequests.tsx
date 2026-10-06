import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue, ProjectRequestStage } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { mobileProjectIssues } from "../../state/projectRequests";
import { useEnvironmentQuery } from "../../state/query";

/** The project page's one status vocabulary (web: TASK_STATUS_LABEL via STAGE_STATUS). */
const STAGE: Partial<Record<ProjectRequestStage, string>> = {
  requested: "Pending",
  "in-progress": "Active",
  ready: "For review",
  "awaiting-release": "Active",
  "needs-test": "For review",
};
const ORDER: ReadonlyArray<ProjectRequestStage> = [
  "needs-test",
  "ready",
  "awaiting-release",
  "in-progress",
  "requested",
];
const MAX_LINES = 4;

function inProject(issue: ProjectIssue, rootThreadId: string): boolean {
  return (
    issue.requestSource?.rootThreadId === rootThreadId ||
    issue.linkedThreadIds.includes(rootThreadId as ProjectIssue["linkedThreadIds"][number])
  );
}

/**
 * Read-only Requests lines under a project on mobile: Brad's open asks, For review
 * first, each with its status; the rest fold into "N more".
 */
export function MobileProjectRequests({ summary }: { readonly summary: OrchestratorSummary }) {
  const query = useEnvironmentQuery(
    mobileProjectIssues({
      environmentId: summary.root.environmentId,
      input: { rootThreadId: summary.root.id },
    }),
  );
  const requests = (query.data?.issues ?? [])
    .filter(
      (issue) =>
        issue.isRequest &&
        issue.stage !== undefined &&
        issue.stage !== "settled" &&
        inProject(issue, summary.root.id),
    )
    .sort((a, b) => ORDER.indexOf(a.stage!) - ORDER.indexOf(b.stage!));
  if (requests.length === 0) return null;
  const more = requests.length - MAX_LINES;
  return (
    <View className="mt-2 gap-0.5">
      <Text className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        Requests {requests.length}
      </Text>
      {requests.slice(0, MAX_LINES).map((issue) => (
        <View key={`${issue.repository}#${issue.number}`} className="flex-row gap-2">
          <Text className="w-20 text-xs text-foreground-muted">{STAGE[issue.stage!]}</Text>
          <Text className="min-w-0 flex-1 text-xs text-foreground">{issue.title}</Text>
        </View>
      ))}
      {more > 0 ? <Text className="text-xs text-foreground-muted">{more} more</Text> : null}
    </View>
  );
}
