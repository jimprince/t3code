import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePullRequestRows } from "./projectPullRequests.logic";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function pr(
  number: number,
  snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "jimprince/t3code",
    number,
    url: `https://github.com/jimprince/t3code/pull/${number}`,
    source: "agent",
    linkedAt: "2026-10-05T08:00:00.000Z",
    snapshot: {
      state: "open",
      title: `PR ${number}`,
      headBranch: `branch-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-10-05T10:00:00.000Z",
      syncedAt: "2026-10-05T11:00:00.000Z",
      ...snapshot,
    },
  } as ThreadPullRequestLink;
}

describe("project pull requests", () => {
  it("groups by what each needs and hides old merged ones", () => {
    const rows = derivePullRequestRows(
      [
        {
          id: "worker-a",
          pullRequests: [
            pr(1, { checksState: "passing", reviewDecision: "review-required" }),
            pr(2, { checksState: "pending" }),
            pr(3, { isDraft: true }),
            pr(4, { state: "merged", mergedAt: "2026-10-04T00:00:00.000Z" }),
            pr(5, { state: "merged", mergedAt: "2026-09-01T00:00:00.000Z" }),
          ],
        },
      ],
      NOW,
    );
    const group = Object.fromEntries(rows.map((row) => [row.link.number, row.group]));
    expect(group).toEqual({ 1: "needs-you", 2: "open", 3: "open", 4: "recent", 5: "hidden" });
    expect(rows.find((row) => row.link.number === 1)).toMatchObject({
      state: "open",
      checks: "passing",
      review: "needs-review",
    });
  });

  it("marks a pull request superseded by a later one from the same branch or thread", () => {
    const rows = derivePullRequestRows(
      [
        { id: "worker-a", pullRequests: [pr(10, { state: "closed" }), pr(12)] },
        { id: "worker-b", pullRequests: [pr(11, { headBranch: "branch-20" }), pr(20)] },
      ],
      NOW,
    );
    const superseded = Object.fromEntries(rows.map((row) => [row.link.number, row.superseded]));
    expect(superseded).toEqual({ 10: true, 11: true, 12: false, 20: false });
    expect(rows.find((row) => row.link.number === 11)?.group).toBe("open");
  });

  it("does not treat the orchestrator's own pull requests as replacing each other", () => {
    const rows = derivePullRequestRows(
      [{ id: "root", pullRequests: [pr(30), pr(31)] }],
      NOW,
      "root",
    );
    expect(rows.every((row) => !row.superseded)).toBe(true);
  });
});
