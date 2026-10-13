import type { DecisionFeedCard, FeedPullRequest } from "@t3tools/client-runtime/decision-feed";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The Later choices that need no typing. */
export const LATER_CHOICES = [
  { id: "15m", label: "15 minutes", ms: 15 * MINUTE_MS },
  { id: "1d", label: "1 day", ms: DAY_MS },
] as const;

/** The instant a quick Later choice returns the card. */
export function laterUntil(now: number, ms: number): string {
  return new Date(now + ms).toISOString();
}

/**
 * A custom Later time from a `datetime-local` field (read in the viewer's time zone), as an
 * instant, or null when it is empty, unreadable or not in the future.
 */
export function parseCustomLater(value: string, now: number): string | null {
  const at = value.trim() ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) || at <= now ? null : new Date(at).toISOString();
}

/** The kind tag on a card. */
export function kindLabel(card: DecisionFeedCard): string {
  switch (card.kind) {
    case "question":
      return "Question";
    case "approval":
      return "Approval";
    case "plan":
      return "Plan";
    case "decision":
      return card.approve ? "Approve" : "Decision";
    case "answer":
      return "Answer";
    case "review":
      return "Review";
    case "test":
      return "Test";
  }
}

/** The line under a card's actions: where the result goes. */
export function resultLine(card: DecisionFeedCard, ownerName: string | null): string {
  const owner = ownerName ?? "the project orchestrator";
  switch (card.kind) {
    case "question":
      return "Answers the thread directly. Its turn resumes.";
    case "approval":
      return "The command runs, or is refused, in that thread.";
    case "plan":
      return "Opens the thread, where the plan is reviewed.";
    case "decision":
      return card.approve
        ? `Comments on #${card.issue.number} and tells ${owner} to go ahead, or to hold.`
        : `Comments on #${card.issue.number} and messages ${owner}.`;
    case "answer":
      return `Settling closes #${card.issue.number}; nobody is told.`;
    case "review":
      return `Send back comments on #${card.issue.number}, moves it to Active and messages ${owner}.`;
    case "test":
      return `Works settles #${card.issue.number}. Broken comments, moves it to Active and messages ${owner}.`;
  }
}

/** What a Review card can do with its pull request: merge it, or why merging is off. */
export function reviewMergeState(pr: FeedPullRequest | null): {
  readonly canMerge: boolean;
  /** Shown beside the merge button when it is off, or as a caution when it is on. */
  readonly note: string | null;
  /** The ready-made Send back note for a branch that cannot merge. */
  readonly rebaseNote: string | null;
} {
  if (pr?.draft) {
    return { canMerge: false, note: "This pull request is a draft.", rebaseNote: null };
  }
  if (pr === null) {
    return {
      canMerge: true,
      note: "The merge looks for the pull request that closes this issue.",
      rebaseNote: null,
    };
  }
  if (pr.conflicting) {
    return {
      canMerge: false,
      note: "Merge is off until the branch is rebased onto main.",
      rebaseNote: "Rebase onto main: PR " + pr.number + " no longer merges cleanly.",
    };
  }
  return { canMerge: true, note: null, rebaseNote: null };
}

/** "PR 195 +541 -3 in 4 files" from what the pull request link knows. */
export function pullRequestSummary(pr: FeedPullRequest): string {
  const parts = [`PR ${pr.number}`];
  if (pr.additions !== null) parts.push(`+${pr.additions}`);
  if (pr.deletions !== null && pr.deletions > 0) parts.push(`-${pr.deletions}`);
  if (pr.changedFiles !== null) {
    parts.push(`in ${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"}`);
  }
  return parts.join(" ");
}
