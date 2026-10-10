import type {
  ProjectIssue,
  ProjectIssueOwner,
  ProjectPendingAsk,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

import { decisionSortTime, decisionVisibility } from "./decisionDeferral.ts";

/** Why an issue waits on Brad when it is not a `needs-brad` decision. */
export type FeedItemGroup = "answers" | "approve" | "review" | "test";

/** An issue the project page already says is for Brad (its Needs you, before the feed). */
export interface FeedItemInput {
  readonly issue: ProjectIssue;
  readonly group: FeedItemGroup;
  /** The step a shipped request asks him to test. */
  readonly testStep?: string | null;
}

/** A thread whose proposed plan waits for Brad. */
export interface FeedPlanInput {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string;
  /** When the thread last changed, as the best "waiting since". */
  readonly since: string;
}

/**
 * One card of the Decisions feed. Every card has a stable `key`, the time it has waited
 * since, and where its answer goes. Threads that are stalled right now (a question, an
 * approval, a plan) are `blocked` and lead the feed.
 */
export type DecisionFeedCard =
  | {
      readonly kind: "question";
      readonly key: string;
      readonly since: string;
      readonly blocked: true;
      readonly project: string;
      readonly ask: Extract<ProjectPendingAsk, { kind: "question" }>;
    }
  | {
      readonly kind: "approval";
      readonly key: string;
      readonly since: string;
      readonly blocked: true;
      readonly project: string;
      readonly ask: Extract<ProjectPendingAsk, { kind: "approval" }>;
    }
  | {
      readonly kind: "plan";
      readonly key: string;
      readonly since: string;
      readonly blocked: true;
      readonly project: string;
      readonly plan: FeedPlanInput;
    }
  | {
      readonly kind: "decision" | "answer" | "review" | "test";
      readonly key: string;
      readonly since: string;
      readonly blocked: false;
      readonly project: string;
      readonly issue: ProjectIssue;
      /** The decision for an `approve` item (an epic or plan to approve) is an Approve / Not yet card. */
      readonly approve: boolean;
      readonly testStep: string | null;
    };

export interface DecisionFeedChip {
  readonly project: string;
  readonly count: number;
}

export interface DecisionFeed {
  /** What shows now: blocked threads first, then the rest, each group newest first. */
  readonly cards: ReadonlyArray<DecisionFeedCard>;
  /** Cards Brad deferred that are still hidden, soonest to return first. */
  readonly later: ReadonlyArray<{
    readonly card: DecisionFeedCard;
    readonly returnsAt: string;
    readonly forDeadline: boolean;
  }>;
  /** Projects that have cards, each with its count, before the project filter. */
  readonly chips: ReadonlyArray<DecisionFeedChip>;
  /** All visible cards before the project filter. */
  readonly total: number;
}

const issueKey = (issue: Pick<ProjectIssue, "repository" | "number">) =>
  `${issue.repository}#${issue.number}`;

const KIND_OF_GROUP: Record<FeedItemGroup, "answer" | "review" | "test" | "decision"> = {
  answers: "answer",
  approve: "decision",
  review: "review",
  test: "test",
};

/**
 * The one feed: thread questions and approvals, plans waiting on Brad, `needs-brad`
 * decisions, and the issues for him to read, approve, review or test. An issue that is
 * both a decision and an item shows once, as the decision. Deferred cards (Later) leave
 * the feed until they return, a day before their deadline at the latest; `project`
 * narrows to one project's cards (chips still count them all).
 */
export function buildDecisionFeed(input: {
  readonly asks: ReadonlyArray<ProjectPendingAsk>;
  readonly plans: ReadonlyArray<FeedPlanInput>;
  /** Open `needs-brad` issues. */
  readonly decisions: ReadonlyArray<ProjectIssue>;
  readonly items: ReadonlyArray<FeedItemInput>;
  readonly now: number;
  readonly project: string | null;
}): DecisionFeed {
  const issueCards = new Map<string, DecisionFeedCard>();
  const projectOf = (issue: ProjectIssue) => issue.owner?.projectTitle ?? "";
  for (const issue of input.decisions) {
    if (issue.decision === undefined) continue;
    issueCards.set(issueKey(issue), {
      kind: "decision",
      key: issueKey(issue),
      since: issue.createdAt,
      blocked: false,
      project: projectOf(issue),
      issue,
      approve: false,
      testStep: null,
    });
  }
  for (const item of input.items) {
    const key = issueKey(item.issue);
    if (issueCards.has(key)) continue;
    issueCards.set(key, {
      kind: KIND_OF_GROUP[item.group],
      key,
      since: item.issue.createdAt,
      blocked: false,
      project: projectOf(item.issue),
      issue: item.issue,
      approve: item.group === "approve",
      testStep: item.testStep ?? null,
    });
  }

  const shown: DecisionFeedCard[] = [];
  const later: Array<DecisionFeed["later"][number]> = [];
  for (const card of issueCards.values()) {
    if (card.blocked) continue;
    const visibility = decisionVisibility({
      deferral: card.issue.deferral,
      deadline: card.issue.decision?.deadline,
      now: input.now,
    });
    if (visibility.hidden && visibility.returnsAt !== null) {
      later.push({ card, returnsAt: visibility.returnsAt, forDeadline: visibility.forDeadline });
    } else {
      shown.push(card);
    }
  }
  const blocked: DecisionFeedCard[] = [
    ...input.asks.map((ask): DecisionFeedCard => {
      const common = {
        key: `${ask.threadId}:${ask.requestId}`,
        since: ask.createdAt,
        blocked: true as const,
        project: ask.projectTitle,
      };
      return ask.kind === "question"
        ? { ...common, kind: "question", ask }
        : { ...common, kind: "approval", ask };
    }),
    ...input.plans.map((plan): DecisionFeedCard => ({
      kind: "plan",
      key: `${plan.threadId}:plan`,
      since: plan.since,
      blocked: true,
      project: plan.projectTitle,
      plan,
    })),
  ].sort(newestFirst);
  const rest = [...shown].sort(newestFirst);

  const all = [...blocked, ...rest];
  const counts = new Map<string, number>();
  for (const card of all) {
    if (card.project) counts.set(card.project, (counts.get(card.project) ?? 0) + 1);
  }
  const chips = [...counts]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
  const inProject = (card: DecisionFeedCard) =>
    input.project === null || card.project === input.project;
  return {
    cards: all.filter(inProject),
    later: later
      .filter((entry) => inProject(entry.card))
      .sort((a, b) => a.returnsAt.localeCompare(b.returnsAt)),
    chips,
    total: all.length,
  };
}

/**
 * Newest first within a group, the key breaking ties so the order never depends on how the
 * cards arrived. A card Brad moved to the end sinks below the rest of its group, the latest
 * move last.
 */
function newestFirst(a: DecisionFeedCard, b: DecisionFeedCard): number {
  const movedA = movedToEndAt(a);
  const movedB = movedToEndAt(b);
  if (movedA !== null || movedB !== null) {
    if (movedA === null) return -1;
    if (movedB === null) return 1;
    return movedA - movedB || a.key.localeCompare(b.key);
  }
  return Date.parse(b.since) - Date.parse(a.since) || a.key.localeCompare(b.key);
}

/** When Brad moved a card to the end, if that was after it was filed. */
function movedToEndAt(card: DecisionFeedCard): number | null {
  if (card.blocked) return null;
  const sortTime = decisionSortTime(card.issue.createdAt, card.issue.deferral);
  return sortTime > Date.parse(card.since) ? sortTime : null;
}

/** Who a card is for, in words: "End Effector Orchestrator" in "Printcell". */
export interface FeedOwner {
  readonly name: string;
  readonly project: string;
  /** The thread that owned the work is gone; `name` is the orchestrator standing in. */
  readonly standingInFor: string | null;
}

export function feedCardOwner(card: DecisionFeedCard): FeedOwner | null {
  if (card.blocked) {
    return card.kind === "plan"
      ? { name: card.plan.title, project: card.plan.projectTitle, standingInFor: null }
      : { name: card.ask.threadTitle, project: card.ask.projectTitle, standingInFor: null };
  }
  const owner: ProjectIssueOwner | undefined = card.issue.owner;
  if (owner === undefined) return null;
  return {
    name: owner.title,
    project: owner.projectTitle,
    standingInFor: owner.previousTitle ?? null,
  };
}

/** The pull request a Review card is about, from the pull requests its linked threads hold. */
export interface FeedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changedFiles: number | null;
  /** Gitea reports the branch cannot merge cleanly (or is still checking). */
  readonly conflicting: boolean;
  /** A draft cannot be merged from a card. */
  readonly draft: boolean;
  /** The head commit the server last saw, to pin the merge to what Brad was shown. */
  readonly headSha: string | null;
}

/**
 * The open pull request of an issue's review: the newest open one, in the issue's own
 * repository, linked from any of the threads that serve it.
 */
export function reviewPullRequest(
  issue: Pick<ProjectIssue, "repository" | "linkedThreadIds">,
  threads: ReadonlyArray<{
    readonly id: string;
    readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  }>,
): FeedPullRequest | null {
  const linked = new Set<string>(issue.linkedThreadIds);
  let best: ThreadPullRequestLink | null = null;
  for (const thread of threads) {
    if (!linked.has(thread.id)) continue;
    for (const link of thread.pullRequests) {
      if (link.repository.toLowerCase() !== issue.repository.toLowerCase()) continue;
      if (link.snapshot !== null && link.snapshot.state !== "open") continue;
      if (best === null || link.linkedAt > best.linkedAt) best = link;
    }
  }
  if (best === null) return null;
  const snapshot = best.snapshot;
  return {
    number: best.number,
    url: best.url,
    additions: snapshot?.additions ?? null,
    deletions: snapshot?.deletions ?? null,
    changedFiles: snapshot?.changedFiles ?? null,
    conflicting: snapshot?.mergeability === "conflicting",
    draft: snapshot?.isDraft === true,
    headSha: best.watch?.headSha ?? null,
  };
}

/** The decision context without its `deadline:` line, which the card shows as a date instead. */
export function withoutDeadlineLine(context: string): string {
  return context
    .split("\n")
    .filter((line) => !/^[\s>*_-]*deadline\s*:/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FENCE = /^\s*(```|~~~)/;

/**
 * A Markdown source cut into its top-level blocks: paragraphs, one list (loose lists stay
 * together), a table, a fenced code block. Card context clamps by these blocks, so a
 * collapsed card shows the lead sentence and its first list or table whole, never half
 * of one.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const text = current.join("\n").trim();
    current = [];
    if (!text) return;
    const previous = blocks[blocks.length - 1];
    const startsList = LIST_ITEM.test(text.split("\n")[0]!);
    const previousIsList = previous !== undefined && LIST_ITEM.test(previous.split("\n")[0]!);
    if (startsList && previousIsList) blocks[blocks.length - 1] = `${previous}\n\n${text}`;
    else blocks.push(text);
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const opening = FENCE.exec(line);
    if (fence !== null) {
      current.push(line);
      if (opening !== null && opening[1] === fence) fence = null;
      continue;
    }
    if (opening !== null) {
      fence = opening[1]!;
      current.push(line);
      continue;
    }
    if (line.trim() === "") flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/** The blocks a collapsed card shows, and how many More would add. */
export function clampMarkdownBlocks(
  blocks: ReadonlyArray<string>,
  limit = 2,
): { readonly shown: ReadonlyArray<string>; readonly hidden: number } {
  return { shown: blocks.slice(0, limit), hidden: Math.max(0, blocks.length - limit) };
}

const HTML_IMG = /<img\b[^>]*>/gi;
const attribute = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];

/**
 * A decision's context ready for the Markdown card: Gitea's editor writes pictures as
 * `<img>` tags, which become Markdown images, and the `deadline:` line (shown as a date
 * on the card) and HTML comments go.
 */
export function decisionContextMarkdown(context: string): string {
  return withoutDeadlineLine(
    context.replace(/<!--[\s\S]*?-->/g, "").replace(HTML_IMG, (tag) => {
      const source = attribute(tag, "src");
      return source ? `![${attribute(tag, "alt") ?? ""}](${source})` : "";
    }),
  );
}

/** A thread the shell says is waiting on Brad, as the project's attention list reports it. */
export interface WaitingThreadInput {
  readonly kind: "approval" | "input";
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly updatedAt: string;
}

/**
 * The asks the feed shows: what the server returned, plus a bare card for every thread
 * that waits but whose text did not arrive (the read failed, or it has not finished), so
 * a waiting thread is never missing from the feed. Nothing is added while the first read
 * is still loading, which would flash cards the text is about to replace.
 */
export function asksWithFallbacks(input: {
  readonly returned: ReadonlyArray<ProjectPendingAsk>;
  readonly waiting: ReadonlyArray<WaitingThreadInput>;
  readonly loading: boolean;
}): ReadonlyArray<ProjectPendingAsk> {
  if (input.loading) return input.returned;
  // An ask whose thread no longer waits was answered elsewhere; the shell knows first.
  const waitingIds = new Set(input.waiting.map((thread) => thread.threadId));
  const returned = input.returned.filter((ask) => waitingIds.has(ask.threadId));
  const covered = new Set<string>(returned.map((ask) => ask.threadId));
  const fallbacks = input.waiting
    .filter((thread) => !covered.has(thread.threadId))
    .map((thread): ProjectPendingAsk => {
      const base = {
        threadId: thread.threadId as ProjectPendingAsk["threadId"],
        threadTitle: thread.title,
        projectTitle: thread.projectTitle,
        requestId: "pending" as ProjectPendingAsk["requestId"],
        createdAt: thread.updatedAt,
        canRespond: false,
      };
      return thread.kind === "input"
        ? { ...base, kind: "question", questions: [], messageResponse: false }
        : { ...base, kind: "approval", requestKind: "permission" };
    });
  return [...returned, ...fallbacks];
}

const TEST_STEP = /^test:\s*(.+)/is;

/**
 * A request whose thread replied while nobody picked it up. The orchestrator's own reply
 * usually means "on it", so from it only a question counts as answered.
 */
function answered(issue: ProjectIssue, labels: ReadonlySet<string>): boolean {
  if (issue.answer === undefined || issue.stage !== "requested") return false;
  const source = issue.requestSource;
  return source === null || source.threadId !== source.rootThreadId || labels.has("ask:question");
}

/**
 * The issues for Brad that are not decisions, from the list alone (mobile has no request
 * tree): the server marks every open card for him with an `owner`. Shipped work to test,
 * work or a plan marked for review (an epic asks for approval), and requests whose thread
 * answered. Web derives the same groups from its request tree.
 */
export function feedItemsOf(issues: ReadonlyArray<ProjectIssue>): FeedItemInput[] {
  return issues.flatMap((issue): FeedItemInput[] => {
    if (issue.closedAt !== null || issue.owner === undefined || issue.decision !== undefined) {
      return [];
    }
    if (issue.labels.some((label) => label.toLowerCase() === "parked")) return [];
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    if (labels.has("needs-test")) {
      const step = TEST_STEP.exec(issue.latestComment?.body.trim() ?? "")?.[1];
      return [{ issue, group: "test", testStep: step ? step.split("\n")[0]!.trim() : null }];
    }
    if (issue.status === "needs-review") {
      return [
        { issue, group: labels.has("ask:epic") || labels.has("ask:plan") ? "approve" : "review" },
      ];
    }
    return answered(issue, labels) ? [{ issue, group: "answers" }] : [];
  });
}
