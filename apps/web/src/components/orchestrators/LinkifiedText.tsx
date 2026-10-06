import { linkifyText, textLinks } from "@t3tools/client-runtime/linkify";
import { Fragment, useMemo } from "react";

const LINK_CLASS = "underline decoration-foreground/40 underline-offset-2 hover:text-foreground";

/** Shortest readable form of a link: host and path, no scheme. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * Agent prose with its http(s) URLs as links. They open in a new tab, which the desktop app
 * hands to the system browser instead of navigating itself.
 */
export function LinkifiedText({ text }: { readonly text: string }) {
  const parts = useMemo(() => linkifyText(text), [text]);
  return parts.map((part, index) =>
    part.kind === "link" ? (
      <a key={index} href={part.url} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {part.text}
      </a>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    ),
  );
}

/**
 * The links in a decision option, under its button: the button sends the answer, so a link
 * inside it could not be clicked on its own.
 */
export function OptionLinks({ text }: { readonly text: string }) {
  const links = useMemo(() => textLinks(text), [text]);
  if (links.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 pl-2 text-xs text-muted-foreground">
      {links.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          {shortUrl(url)}
        </a>
      ))}
    </span>
  );
}
