import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { useMemo, useState } from "react";

import { InlineButton } from "../ui/button";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { GroupTitle, ProjectSection } from "./ProjectSection";
import { ProjectPullRequestLink } from "./ProjectPullRequestLink";
import {
  derivePullRequestRows,
  type ProjectPullRequestRow,
  type PullRequestGroup,
} from "./projectPullRequests.logic";

const GROUPS: ReadonlyArray<{ group: PullRequestGroup; title: string }> = [
  { group: "needs-you", title: "For review" },
  { group: "open", title: "Open" },
  { group: "recent", title: "Recently merged or closed" },
];

const CHECKS = { passing: "checks passing", failing: "checks failing", pending: "checks pending" };
const REVIEW = {
  "needs-review": "needs your review",
  approved: "approved",
  "changes-requested": "changes requested",
};

function Row({
  summary,
  row,
  now,
}: {
  readonly summary: OrchestratorSummary;
  readonly row: ProjectPullRequestRow;
  readonly now: number;
}) {
  const parts = [
    row.superseded ? "superseded" : null,
    row.state === "unconfirmed" ? "not refreshed" : row.state,
    row.checks ? CHECKS[row.checks] : null,
    row.review ? REVIEW[row.review] : null,
    row.conflicting ? "conflicts" : null,
  ].filter(Boolean);
  return (
    <li className="flex items-baseline gap-3 py-1.5">
      <span className="shrink-0">
        <ProjectPullRequestLink summary={summary} pullRequest={row.link} />
      </span>
      <span
        className={`min-w-0 flex-1 text-sm ${row.superseded ? "text-muted-foreground line-through" : ""}`}
      >
        {row.link.snapshot?.title ?? ""}
      </span>
      <span
        className={`shrink-0 text-xs ${row.checks === "failing" || row.review === "changes-requested" ? "text-error" : "text-muted-foreground"}`}
      >
        {parts.join(" · ")}
      </span>
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatIssueAge(row.changedAt, now)}
      </span>
    </li>
  );
}

/**
 * The project's pull requests by what they need: Brad's review or merge, still
 * open on CI or agents, recently merged or closed (collapsed). Each row says its
 * state, checks, review and age; older merged and closed ones are hidden.
 */
export function ProjectPullRequestsWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const [now] = useState(() => Date.now());
  const [showRecent, setShowRecent] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const rows = useMemo(
    () => derivePullRequestRows([summary.root, ...summary.descendants], now, summary.root.id),
    [now, summary.descendants, summary.root],
  );
  const hidden = rows.filter((row) => row.group === "hidden");
  const recent = rows.filter((row) => row.group === "recent");
  const openCount = rows.length - hidden.length - recent.length;
  // Only open pull requests earn the widget its place; merged or closed ones fold under them.
  if (openCount === 0) return null;
  return (
    <ProjectSection title="Pull requests" count={openCount}>
      {GROUPS.map(({ group, title }) => {
        const items = rows.filter((row) => row.group === group);
        if (items.length === 0) return null;
        const collapsed = group === "recent" && !showRecent;
        return (
          <div key={group} className="mb-2">
            {group === "recent" ? (
              <p className="mb-1 text-xs">
                <InlineButton
                  tone="muted"
                  aria-expanded={showRecent}
                  onClick={() => setShowRecent((value) => !value)}
                >
                  {title} {items.length}
                </InlineButton>
              </p>
            ) : (
              <GroupTitle title={title} count={items.length} />
            )}
            {collapsed ? null : (
              <ul className="divide-y divide-border">
                {items.map((row) => (
                  <Row key={row.link.url} summary={summary} row={row} now={now} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {hidden.length > 0 ? (
        <div>
          <p className="text-xs">
            <InlineButton
              tone="muted"
              aria-expanded={showHidden}
              onClick={() => setShowHidden((value) => !value)}
            >
              {showHidden ? "Hide" : "Show"} {hidden.length} older merged or closed
            </InlineButton>
          </p>
          {showHidden ? (
            <ul className="divide-y divide-border">
              {hidden.map((row) => (
                <Row key={row.link.url} summary={summary} row={row} now={now} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </ProjectSection>
  );
}
