import { projectBlockerSet } from "@t3tools/client-runtime/dashboard/blockers";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { useMemo } from "react";

import { BlockedBadge } from "../blockers/BlockerBadge";
import { useBlockerPermissions } from "../blockers/useBlockerActions";
import { useMinuteClock } from "../dashboard-v3/prefs";
import { useTaskStatuses } from "./ProjectRequestsSection";
import { issueKey } from "./projectRequests.logic";

/**
 * "N blocked" in a project page's status line: the exact list its popover shows. It is the
 * summary's blocked threads (subprojects included) plus the Active tasks held by an open issue or
 * gone quiet, so the number can never exceed or fall short of the names listed.
 */
export function ProjectBlockedCount({ summary }: { readonly summary: OrchestratorSummary }) {
  const { statuses, query } = useTaskStatuses(summary);
  const permissions = useBlockerPermissions(summary.root.environmentId);
  const clock = useMinuteClock();
  const issues = query.data?.issues;
  const blockers = useMemo(
    () =>
      projectBlockerSet(summary, issues ?? [], {
        ...permissions,
        now: new Date(clock).toISOString(),
        activeIssueKeys: new Set(
          (issues ?? [])
            .filter((issue) => statuses.get(issueKey(issue)) === "active")
            .map((issue) => `${issue.host}/${issue.repository}#${issue.number}`),
        ),
      }),
    [clock, issues, permissions, statuses, summary],
  );
  return (
    <BlockedBadge
      summary={summary}
      blockers={blockers}
      active={blockers.length > 0}
      label={`${blockers.length} blocked`}
    />
  );
}
