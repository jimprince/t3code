import type { DecisionFeedCard, FeedPullRequest } from "@t3tools/client-runtime/decision-feed";
import { describe, expect, it } from "vite-plus/test";

import {
  deadlineNote,
  laterUntil,
  parseCustomLater,
  pullRequestSummary,
  resultLine,
  reviewMergeState,
} from "./decisionFeed.logic";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

describe("Later", () => {
  it("returns a quick choice at now plus its length", () => {
    expect(laterUntil(NOW, 15 * 60_000)).toBe("2026-10-08T12:15:00.000Z");
  });

  it("takes a custom time only when it is readable and in the future", () => {
    expect(parseCustomLater("2026-10-09T09:00", NOW)).not.toBeNull();
    expect(parseCustomLater("2026-10-07T09:00", NOW)).toBeNull();
    expect(parseCustomLater("", NOW)).toBeNull();
    expect(parseCustomLater("soon", NOW)).toBeNull();
  });
});

describe("deadlineNote", () => {
  it("counts a date deadline from its UTC day", () => {
    expect(deadlineNote("2026-10-08", NOW)).toBe("due today");
    expect(deadlineNote("2026-10-09", NOW)).toBe("due tomorrow");
    expect(deadlineNote("2026-10-20", NOW)).toMatch(/^due .*20/);
    expect(deadlineNote("2026-10-05", NOW)).toBe("overdue");
    expect(deadlineNote("garbage", NOW)).toBe("");
  });
});

describe("resultLine", () => {
  const issueCard = (kind: "decision" | "review" | "test" | "answer", approve = false) =>
    ({
      kind,
      approve,
      issue: { number: 133 },
    }) as unknown as DecisionFeedCard;

  it("tells where each kind of result goes", () => {
    expect(resultLine(issueCard("decision"), "End Effector Orchestrator")).toBe(
      "Comments on #133 and messages End Effector Orchestrator.",
    );
    expect(resultLine(issueCard("review"), null)).toContain("messages the project orchestrator");
    expect(resultLine(issueCard("test"), "W")).toContain("Works settles #133");
    expect(resultLine(issueCard("decision", true), "W")).toContain("go ahead");
    expect(resultLine({ kind: "question" } as DecisionFeedCard, null)).toContain("thread directly");
  });
});

describe("review actions", () => {
  const pr = (extra: Partial<FeedPullRequest> = {}): FeedPullRequest => ({
    number: 195,
    url: "http://git/pulls/195",
    additions: 541,
    deletions: 0,
    changedFiles: 4,
    conflicting: false,
    draft: false,
    headSha: null,
    ...extra,
  });

  it("turns merging off for a branch that conflicts and offers the rebase note", () => {
    const state = reviewMergeState(pr({ conflicting: true }));
    expect(state.canMerge).toBe(false);
    expect(state.note).toContain("rebased");
    expect(state.rebaseNote).toContain("PR 195");
    expect(reviewMergeState(pr()).canMerge).toBe(true);
  });

  it("turns merging off for a draft", () => {
    expect(reviewMergeState(pr({ draft: true }))).toMatchObject({
      canMerge: false,
      note: "This pull request is a draft.",
    });
  });

  it("still lets the server look for the pull request when none is linked", () => {
    expect(reviewMergeState(null)).toMatchObject({ canMerge: true, rebaseNote: null });
  });

  it("summarizes the pull request", () => {
    expect(pullRequestSummary(pr())).toBe("PR 195 +541 in 4 files");
    expect(pullRequestSummary(pr({ deletions: 3, changedFiles: 1 }))).toBe(
      "PR 195 +541 -3 in 1 file",
    );
    expect(pullRequestSummary(pr({ additions: null, deletions: null, changedFiles: null }))).toBe(
      "PR 195",
    );
  });
});
