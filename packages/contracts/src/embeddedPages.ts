import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Whether a string is an absolute http(s) URL, the only kind a page can frame or open. */
function isEmbeddedPageUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A user-configured web page shown from the sidebar footer, such as a status
 * board. `icon` is a free string rather than a literal set so an icon picked on
 * a newer client decodes on an older one (which draws its default instead of
 * rejecting the whole settings snapshot).
 */
export const EmbeddedPage = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString.check(
    Schema.makeFilter((url) => isEmbeddedPageUrl(url) || "Expected an http(s) URL."),
  ),
  icon: Schema.String,
});
export type EmbeddedPage = typeof EmbeddedPage.Type;

export const EmbeddedPages = Schema.Array(EmbeddedPage);

/**
 * The list a client shows. `embeddedPages` is a shared server setting, so every
 * connected environment normally holds the same list; the primary environment
 * wins when it has loaded, and clients without one (mobile, the hosted web app)
 * take the first environment that has any pages.
 */
export function resolveEmbeddedPages(
  primary: { readonly embeddedPages: readonly EmbeddedPage[] } | null,
  environments: ReadonlyArray<{ readonly embeddedPages: readonly EmbeddedPage[] } | null>,
): readonly EmbeddedPage[] {
  if (primary !== null) return primary.embeddedPages;
  return (
    environments.find((settings) => (settings?.embeddedPages.length ?? 0) > 0)?.embeddedPages ?? []
  );
}
