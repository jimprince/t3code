import type { ThreadLinkedPullRequest, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";

/** Keep the imported compatibility link aligned with its authoritative V2 link. */
export function synchronizedLegacyPullRequest(
  legacy: ThreadLinkedPullRequest | null | undefined,
  links: ReadonlyArray<ThreadPullRequestLink>,
  previousLinks: ReadonlyArray<ThreadPullRequestLink> = links,
) {
  if (legacy == null) return null;
  // Older rows could retain an API/SSH origin in the URL while their explicit key
  // was already correct. Repair only an exact old URL match with one identity.
  const matching = previousLinks.filter(
    (link) =>
      link.source !== "stack-dismissed" &&
      link.url === legacy.url &&
      link.repository.toLowerCase() === legacy.repository.toLowerCase() &&
      link.number === legacy.number,
  );
  const key = matching.length === 1 ? matching[0]! : legacyThreadPullRequestKey(legacy);
  const current = links.find(
    (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, key),
  );
  return current ? { ...legacy, url: current.url } : null;
}
