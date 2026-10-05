import type { EmbeddedPage, ThreadIssueLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadIssueBadgeTarget } from "./ThreadIssueBadges";

const issue: ThreadIssueLink = {
  host: "git.bradleyprince.com",
  repository: "brad/t3code-fork",
  number: 73,
  url: "https://git.bradleyprince.com/brad/t3code-fork/issues/73",
  linkedAt: "2026-10-03T00:00:00.000Z",
  snapshot: {
    title: "Show linked issues",
    state: "open",
    syncedAt: "2026-10-03T00:00:00.000Z",
  },
};

describe("thread issue badge target", () => {
  it("deep-links the configured Agent Status Board", () => {
    const pages = [
      {
        id: "board",
        name: "Agent Status Board",
        url: "https://control.bradleyprince.com:8450/",
        icon: "activity",
      },
    ] as readonly EmbeddedPage[];
    expect(resolveThreadIssueBadgeTarget(pages, issue)).toEqual({
      kind: "embedded",
      pageId: "board",
      repo: "t3code-fork",
      issue: "73",
    });
  });

  it("falls back to the canonical Gitea issue URL", () => {
    expect(resolveThreadIssueBadgeTarget([], issue)).toEqual({
      kind: "external",
      url: issue.url,
    });
  });

  it("resolves project-board issues without requiring a thread-link snapshot", () => {
    expect(
      resolveThreadIssueBadgeTarget(
        [
          {
            id: "board",
            name: "Agent Status Board",
            url: "https://control.bradleyprince.com:8450/",
            icon: "activity",
          },
        ] as readonly EmbeddedPage[],
        { repository: issue.repository, number: issue.number, url: issue.url },
      ),
    ).toMatchObject({ kind: "embedded", repo: "t3code-fork", issue: "73" });
  });
});
