import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue, ProjectRequestStage } from "@t3tools/contracts";
import { Text, View } from "react-native";

import { mobileProjectIssues } from "../../state/projectRequests";
import { useEnvironmentQuery } from "../../state/query";

const STAGE: Partial<Record<ProjectRequestStage, string>> = {
  requested: "requested",
  "in-progress": "in progress",
  ready: "ready for you",
  "awaiting-release": "next release",
  "needs-test": "ready to test",
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
 * Read-only Requests and Release lines under a project on mobile: Brad's open
 * asks by stage, what the next release carries, and what shipped for him to test.
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
  const nextRelease = requests.filter((issue) => issue.stage === "awaiting-release").length;
  const toTest = requests.filter((issue) => issue.stage === "needs-test").length;
  return (
    <View className="mt-2 gap-0.5">
      <Text className="text-xs text-foreground-muted">
        {requests.length} requests · {nextRelease} in next release · {toTest} to test
      </Text>
      {requests.slice(0, MAX_LINES).map((issue) => (
        <View key={`${issue.repository}#${issue.number}`} className="flex-row gap-2">
          <Text className="w-24 text-xs text-foreground-muted">{STAGE[issue.stage!]}</Text>
          <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
            {issue.title}
            {issue.stage === "needs-test" && issue.milestone ? ` (${issue.milestone.title})` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}
