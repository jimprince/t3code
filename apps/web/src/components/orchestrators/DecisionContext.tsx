import {
  decisionContextText,
  parseDecisionContext,
  type DecisionContextImage,
  type DecisionContextPart,
} from "@t3tools/client-runtime/decision-context";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Fragment, useMemo, useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { InlineButton } from "../ui/button";

function ContextText({ parts }: { readonly parts: ReadonlyArray<DecisionContextPart> }) {
  return parts.map((part, index) =>
    part.kind === "link" ? (
      <a
        key={index}
        href={part.url}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-foreground/40 underline-offset-2 hover:text-foreground"
      >
        {part.text}
      </a>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    ),
  );
}

/**
 * One embedded picture: fetched through the server, which holds the Gitea token a private
 * repository needs, or directly when it is not a Gitea upload. Opens full size in a new tab.
 */
function ContextImage({
  environmentId,
  image,
}: {
  readonly environmentId: EnvironmentId;
  readonly image: DecisionContextImage;
}) {
  const resource = useMemo<AssetResource>(
    () => ({ _tag: "gitea-media", url: image.url }),
    [image.url],
  );
  const state = useAssetUrlState(environmentId, resource);
  const src = state._tag === "Success" ? state.url : state._tag === "Failure" ? image.url : null;
  if (src === null) {
    return <span className="block size-16 rounded-md border border-border" />;
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      aria-label={image.alt ? `${image.alt} (open full size)` : "Open picture full size"}
      className="block"
    >
      <img
        src={src}
        alt={image.alt}
        loading="lazy"
        className="h-16 max-w-40 rounded-md border border-border object-cover"
      />
    </a>
  );
}

/**
 * A decision's context with its links clickable and its pictures as thumbnails. Long context
 * is clamped to a few lines (or shows `summary`, when given) with More to read all of it, so a
 * collapsed card stays scannable.
 */
export function DecisionContext({
  environmentId,
  text,
  issueUrl,
  summary,
}: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly issueUrl: string;
  /** A short form shown while collapsed, such as the first sentences of a comment. */
  readonly summary?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const full = useMemo(() => parseDecisionContext(text, issueUrl), [text, issueUrl]);
  const short = useMemo(
    () => (summary ? parseDecisionContext(summary, issueUrl) : null),
    [summary, issueUrl],
  );
  const expandable = short
    ? decisionContextText(short.parts).trim() !== decisionContextText(full.parts).trim()
    : full.long;
  const shown = expanded || !short ? full.parts : short.parts;
  if (shown.length === 0 && full.images.length === 0) return null;
  return (
    <span className="mt-1 block">
      {shown.length > 0 ? (
        <span
          className={cn(
            "block text-sm whitespace-pre-line wrap-anywhere text-foreground/85",
            expandable && !expanded && !short && "line-clamp-3",
          )}
        >
          <ContextText parts={shown} />
        </span>
      ) : null}
      {full.images.length > 0 ? (
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {full.images.map((image) => (
            <ContextImage key={image.url} environmentId={environmentId} image={image} />
          ))}
        </span>
      ) : null}
      {expandable ? (
        <span className="mt-0.5 block text-xs">
          <InlineButton tone="muted" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Less" : "More"}
          </InlineButton>
        </span>
      ) : null}
    </span>
  );
}
