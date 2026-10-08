import { textLinks } from "@t3tools/client-runtime/linkify";
import { useMemo } from "react";

const LINK_CLASS = "underline decoration-foreground/40 underline-offset-2 hover:text-foreground";

/** Shortest readable form of a link: host and path, no scheme. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * The links in a decision option, under its button: the button sends the answer, so a link
 * inside it could not be clicked on its own.
 */
export function OptionLinks({ text }: { readonly text: string }) {
  const links = useMemo(() => textLinks(text), [text]);
  if (links.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 pl-2 text-xs wrap-anywhere text-muted-foreground">
      {links.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          {shortUrl(url)}
        </a>
      ))}
    </span>
  );
}
