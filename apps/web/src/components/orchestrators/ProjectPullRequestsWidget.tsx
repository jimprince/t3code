import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { useMemo, useState } from "react";

import { formatIssueAge } from "./projectIssuesBoard.logic";
import { ProjectPullRequestLink } from "./ProjectPullRequestLink";
import {
  derivePullRequestRows,
  type ProjectPullRequestRow,
  type PullRequestGroup,
} from "./projectPullRequests.logic";

const GROUPS: ReadonlyArray<{ group: PullRequestGroup; title: string }> = [
  { group: "needs-you", title: "Needs you" },
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
    <li className="flex items-center gap-3 py-1.5">
      <span className="shrink-0">
        <ProjectPullRequestLink summary={summary} pullRequest={row.link} />
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-sm ${row.superseded ? "text-muted-foreground line-through" : ""}`}
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
  if (rows.length === 0) return null;
  return (
    <section className="border-t border-border pt-4">
      {/* The count is open pull requests; merged or closed ones get one line of their own. */}
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Pull requests
        {openCount > 0 ? (
          <span className="tabular-nums text-foreground/60">{openCount}</span>
        ) : null}
      </h2>
      {GROUPS.map(({ group, title }) => {
        const items = rows.filter((row) => row.group === group);
        if (items.length === 0) return null;
        const collapsed = group === "recent" && !showRecent;
        return (
          <div key={group} className="mb-2">
            {group === "recent" ? (
              <button
                type="button"
                className="mb-1 text-xs text-foreground/80 hover:text-foreground"
                aria-expanded={showRecent}
                onClick={() => setShowRecent((value) => !value)}
              >
                {title} <span className="tabular-nums text-muted-foreground">{items.length}</span>
              </button>
            ) : (
              <h3 className="mb-1 text-xs text-foreground/80">
                {title} <span className="tabular-nums text-muted-foreground">{items.length}</span>
              </h3>
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
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={showHidden}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? "Hide" : "Show"} {hidden.length} older merged or closed
          </button>
          {showHidden ? (
            <ul className="divide-y divide-border">
              {hidden.map((row) => (
                <Row key={row.link.url} summary={summary} row={row} now={now} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
