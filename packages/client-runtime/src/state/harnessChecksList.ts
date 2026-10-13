import type { HarnessThreadLink } from "@t3tools/contracts";
import { splitHarnessChecks, type HarnessCheckView } from "./harnessView.ts";

/**
 * Looks up an owner thread's title for the filter. Checks carry only the owner's link; each client
 * builds this from the thread shells it already holds.
 */
export type HarnessOwnerTitle = (link: HarnessThreadLink) => string | undefined;

export function harnessOwnerTitles(
  threads: Iterable<{
    readonly environmentId: string;
    readonly id: string;
    readonly title: string;
  }>,
): HarnessOwnerTitle {
  const titles = new Map<string, string>();
  for (const thread of threads) titles.set(`${thread.environmentId}\0${thread.id}`, thread.title);
  return (link) => titles.get(`${link.environmentId}\0${link.threadId}`);
}

/**
 * A source-feed row rather than a check: a feed nothing reports from yet ("not shown yet"), or a
 * feed whose source went stale. They say a source is missing, not that a check ran, and fill the
 * list when many feeds are not set up. A failing feed is never one: it needs a look.
 */
export function isHarnessFeedRow(check: Pick<HarnessCheckView, "state" | "key">): boolean {
  return (
    check.state === "not-shown" || (check.state === "source-stale" && check.key.includes(":feed:"))
  );
}

/** Every whitespace-separated word of `query` must appear in the check's name, owner, schedule or state words. */
export function matchesHarnessCheckQuery(
  check: HarnessCheckView,
  query: string,
  ownerTitle?: HarnessOwnerTitle,
): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return true;
  const haystack = [
    check.name,
    check.owner ? ownerTitle?.(check.owner) : undefined,
    check.schedule,
    check.stateLabel,
    check.latenessLabel,
    check.lifecycleLabel,
    check.contextLabel,
    check.livenessLabel,
    check.unclassified ? "unclassified" : undefined,
  ]
    .filter((part) => part !== undefined && part !== null)
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface HarnessFeedGroup {
  /** "14 feeds not reporting", or "2 of 14 feeds not reporting" while filtering. */
  readonly label: string;
  readonly checks: ReadonlyArray<HarnessCheckView>;
}

export interface HarnessChecksList {
  /** Real checks, sorted: failing and overdue first, a check not run yet above the feed group. */
  readonly checks: ReadonlyArray<HarnessCheckView>;
  /** Source-feed rows folded into one collapsed row at the end; null when there are none to show. */
  readonly feeds: HarnessFeedGroup | null;
  /** The group opens by itself when a filter matches inside it. */
  readonly feedsOpen: boolean;
  readonly unclassified: ReadonlyArray<HarnessCheckView>;
  readonly filtering: boolean;
  /** Nothing matches the filter; show "No checks match". */
  readonly noMatches: boolean;
}

/**
 * The Checks list: real Harness checks in their order, then one group row for source-feed rows,
 * then unclassified routines. A filter narrows all three; unfiltered, nothing real is hidden.
 */
export function buildHarnessChecksList(
  checks: ReadonlyArray<HarnessCheckView>,
  query: string,
  ownerTitle?: HarnessOwnerTitle,
): HarnessChecksList {
  const filtering = query.trim() !== "";
  const keep = (check: HarnessCheckView) =>
    !filtering || matchesHarnessCheckQuery(check, query, ownerTitle);
  const { harness, unclassified } = splitHarnessChecks(checks);
  const feedRows = harness.filter(isHarnessFeedRow);
  const shownFeeds = feedRows.filter(keep);
  const shownChecks = harness.filter((check) => !isHarnessFeedRow(check) && keep(check));
  const shownUnclassified = unclassified.filter(keep);
  const noun = (count: number) => `${count} feed${count === 1 ? "" : "s"} not reporting`;
  return {
    checks: shownChecks,
    feeds:
      shownFeeds.length === 0
        ? null
        : {
            label: filtering
              ? `${shownFeeds.length} of ${noun(feedRows.length)}`
              : noun(shownFeeds.length),
            checks: shownFeeds,
          },
    feedsOpen: filtering && shownFeeds.length > 0,
    unclassified: shownUnclassified,
    filtering,
    noMatches: filtering && shownChecks.length + shownFeeds.length + shownUnclassified.length === 0,
  };
}
