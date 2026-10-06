import type { EmbeddedPage } from "@t3tools/contracts";

/**
 * How the main area shows an embedded page on this client.
 *
 * - `webview`: the desktop app hosts the page in an Electron guest on the
 *   Browser panel's partition. A guest is its own top-level page, so neither
 *   mixed-content blocking nor SameSite cookie rules apply, and a sign-in made
 *   in the Browser panel carries over.
 * - `iframe`: a browser frame. Cookies are third-party here, so a page whose
 *   login cookie is `SameSite=Lax` (the common default) cannot stay signed in
 *   unless it is on the same site as this app; the header always offers
 *   "Open in browser" for that case. A site that refuses framing outright
 *   (X-Frame-Options, CSP frame-ancestors) shows the browser's blank error
 *   page, and that refusal cannot be observed from this page, so the header
 *   action is the fallback there too.
 * - `blocked`: the browser refuses to load it at all, so the view explains why
 *   instead of drawing an empty frame.
 */
export type EmbeddedPageHost =
  | { readonly kind: "webview" }
  | { readonly kind: "iframe" }
  | { readonly kind: "blocked"; readonly reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resolveEmbeddedPageHost(
  url: string,
  client: { readonly desktopWebview: boolean; readonly appProtocol: string },
): EmbeddedPageHost {
  if (client.desktopWebview) return { kind: "webview" };
  const page = new URL(url);
  // Browsers block http frames inside an https page (mixed content), except
  // for loopback hosts, which count as secure.
  if (
    client.appProtocol === "https:" &&
    page.protocol === "http:" &&
    !LOOPBACK_HOSTS.has(page.hostname)
  ) {
    return {
      kind: "blocked",
      reason:
        "This page is served over http and T3 Code is open over https, so the browser will not show it here.",
    };
  }
  return { kind: "iframe" };
}

/**
 * The Agent Status Board address that carries an issue. The board routes `/`
 * by exact match, so any query string on it answers `{"error":"not found"}`;
 * its `/index` alias takes a query and serves the same page.
 */
export function statusBoardIssueUrl(pageUrl: string, repo: string, issue: string): string {
  const url = new URL(pageUrl);
  if (url.pathname === "/") url.pathname = "/index";
  url.searchParams.set("repo", repo);
  url.searchParams.set("issue", issue);
  return url.toString();
}

export function findEmbeddedPage(
  pages: readonly EmbeddedPage[],
  pageId: string,
): EmbeddedPage | null {
  return pages.find((page) => page.id === pageId) ?? null;
}

/** Moves the page at `index` one step; out-of-range moves return the list unchanged. */
export function moveEmbeddedPage(
  pages: readonly EmbeddedPage[],
  index: number,
  direction: -1 | 1,
): readonly EmbeddedPage[] {
  const target = index + direction;
  if (index < 0 || index >= pages.length || target < 0 || target >= pages.length) return pages;
  const next = [...pages];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
