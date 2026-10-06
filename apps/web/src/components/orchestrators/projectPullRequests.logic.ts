import type { ThreadPullRequestLink } from "@t3tools/contracts";

export type PullRequestRowState = "draft" | "open" | "merged" | "closed";
export type PullRequestGroup = "needs-you" | "open" | "recent" | "hidden";

export interface ProjectPullRequestRow {
  readonly link: ThreadPullRequestLink;
  /** Tree threads that link this pull request. */
  readonly threadIds: ReadonlyArray<string>;
  readonly state: PullRequestRowState;
  readonly checks: "passing" | "failing" | "pending" | null;
  readonly review: "needs-review" | "approved" | "changes-requested" | null;
  readonly conflicting: boolean;
  /** A later pull request from the same thread or branch replaced it. */
  readonly superseded: boolean;
  /** When it last changed: closed, merged, updated, or linked. */
  readonly changedAt: string;
  readonly group: PullRequestGroup;
}

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

interface ThreadWithPullRequests {
  readonly id: string;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

const keyOf = (link: Pick<ThreadPullRequestLink, "host" | "repository" | "number">) =>
  `${link.host.toLowerCase()}/${link.repository.toLowerCase()}#${link.number}`;

/**
 * What each of the project's pull requests needs: Brad's review or merge, still
 * open on CI or agents, or recently merged or closed. Older merged and closed
 * ones are hidden, and one replaced by a later pull request from the same thread
 * or branch is marked superseded.
 */
export function derivePullRequestRows(
  threads: ReadonlyArray<ThreadWithPullRequests>,
  now: number,
  rootThreadId?: string,
): ProjectPullRequestRow[] {
  const byKey = new Map<string, { link: ThreadPullRequestLink; threadIds: Set<string> }>();
  for (const thread of threads) {
    for (const link of thread.pullRequests) {
      if (link.source === "stack-dismissed") continue;
      const key = keyOf(link);
      const existing = byKey.get(key);
      const newer =
        !existing || (link.snapshot?.syncedAt ?? "") > (existing.link.snapshot?.syncedAt ?? "");
      byKey.set(key, {
        link: newer ? link : existing!.link,
        threadIds: new Set([...(existing?.threadIds ?? []), thread.id]),
      });
    }
  }
  const entries = [...byKey.values()];
  return entries
    .map(({ link, threadIds }): ProjectPullRequestRow => {
      const snapshot = link.snapshot;
      const state: PullRequestRowState =
        snapshot?.state === "merged"
          ? "merged"
          : snapshot?.state === "closed"
            ? "closed"
            : snapshot?.isDraft
              ? "draft"
              : "open";
      // A later pull request on the same branch replaces this one; from the same
      // worker thread it does only once this one was closed without merging (a
      // worker may keep several independent pull requests open). The orchestrator
      // links many unrelated ones, so its thread never counts.
      const replacedBy = entries.some((other) => {
        if (
          other.link === link ||
          other.link.repository.toLowerCase() !== link.repository.toLowerCase() ||
          other.link.number <= link.number ||
          other.link.snapshot?.state === "closed"
        ) {
          return false;
        }
        const sameBranch =
          snapshot?.headBranch !== undefined &&
          other.link.snapshot?.headBranch === snapshot.headBranch;
        const sameWorker =
          state === "closed" &&
          [...other.threadIds].some((id) => id !== rootThreadId && threadIds.has(id));
        return sameBranch || sameWorker;
      });
      const superseded = state !== "merged" && replacedBy;
      const review: ProjectPullRequestRow["review"] =
        snapshot?.reviewDecision === "approved"
          ? "approved"
          : snapshot?.reviewDecision === "changes-requested"
            ? "changes-requested"
            : snapshot?.reviewDecision === "review-required"
              ? "needs-review"
              : null;
      const checks = snapshot?.checksState ?? null;
      const changedAt =
        snapshot?.mergedAt ?? snapshot?.closedAt ?? snapshot?.updatedAt ?? link.linkedAt;
      const open = state === "open" || state === "draft";
      const group: PullRequestGroup = open
        ? state === "open" &&
          !superseded &&
          review !== "changes-requested" &&
          checks !== "failing" &&
          checks !== "pending" &&
          snapshot?.mergeability !== "conflicting"
          ? "needs-you"
          : "open"
        : now - Date.parse(changedAt) <= RECENT_MS
          ? "recent"
          : "hidden";
      return {
        link,
        threadIds: [...threadIds],
        state,
        checks,
        review,
        conflicting: snapshot?.mergeability === "conflicting",
        superseded,
        changedAt,
        group,
      };
    })
    .toSorted((a, b) => b.changedAt.localeCompare(a.changedAt));
}
