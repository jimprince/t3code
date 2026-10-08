import {
  clampMarkdownBlocks,
  decisionContextMarkdown,
  splitMarkdownBlocks,
} from "@t3tools/client-runtime/decision-feed";
import type { EnvironmentId } from "@t3tools/contracts";
import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { InlineButton } from "../ui/button";
import { ContextImage } from "./DecisionContext";

/** An http(s) URL, with relative ones (Gitea writes `/attachments/<uuid>`) read against the issue. */
function absoluteUrl(value: string | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const Plain = ({ children }: { readonly children?: ReactNode }) => <>{children}</>;

/**
 * The few elements a decision's context uses: a lead sentence, bullets, a small
 * comparison table, links and pictures. Deliberately not the chat renderer: no code
 * highlighting, file links, mentions or copy buttons, so a card stays light.
 */
function contextComponents(environmentId: EnvironmentId, issueUrl: string): Components {
  return {
    p: ({ children }) => <p className="text-sm wrap-anywhere text-foreground/85">{children}</p>,
    h1: ({ children }) => <p className="text-sm font-semibold">{children}</p>,
    h2: ({ children }) => <p className="text-sm font-semibold">{children}</p>,
    h3: ({ children }) => <p className="text-sm font-semibold">{children}</p>,
    h4: ({ children }) => <p className="text-sm font-semibold">{children}</p>,
    h5: ({ children }) => <p className="text-sm font-semibold">{children}</p>,
    h6: ({ children }) => <p className="text-sm font-semibold">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
    ul: ({ children }) => (
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground/85">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal space-y-0.5 pl-5 text-sm text-foreground/85">{children}</ol>
    ),
    li: ({ children }) => <li className="wrap-anywhere">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {children}
      </blockquote>
    ),
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-px font-mono text-xs">{children}</code>
    ),
    pre: ({ children }) => (
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{children}</pre>
    ),
    hr: () => null,
    a: ({ href, children }) => {
      const url = absoluteUrl(href, issueUrl);
      return url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-foreground/40 underline-offset-2 hover:text-foreground"
        >
          {children}
        </a>
      ) : (
        <Plain>{children}</Plain>
      );
    },
    img: ({ src, alt }) => {
      const url = absoluteUrl(typeof src === "string" ? src : undefined, issueUrl);
      return url ? (
        <ContextImage environmentId={environmentId} image={{ alt: alt ?? "", url }} />
      ) : null;
    },
    table: ({ children }) => (
      <div className="max-w-full overflow-x-auto">
        <table className="border-collapse text-left text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-border py-1 pr-4 font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border-b border-border/50 py-1 pr-4">{children}</td>,
  };
}

/**
 * A decision's context as Markdown: a lead sentence, bullets, small tables, links and
 * pictures. It clamps by whole blocks (the lead and its first list or table), with More for
 * the rest, so a collapsed card stays scannable and never cuts a list in half.
 */
export const DecisionMarkdown = memo(function DecisionMarkdown({
  environmentId,
  markdown,
  issueUrl,
  clamp = 2,
}: {
  readonly environmentId: EnvironmentId;
  readonly markdown: string;
  readonly issueUrl: string;
  readonly clamp?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const blocks = useMemo(() => splitMarkdownBlocks(decisionContextMarkdown(markdown)), [markdown]);
  const components = useMemo(
    () => contextComponents(environmentId, issueUrl),
    [environmentId, issueUrl],
  );
  if (blocks.length === 0) return null;
  const { shown, hidden } = clampMarkdownBlocks(blocks, clamp);
  const visible = expanded ? blocks : shown;
  // Two identical blocks (a repeated rule or heading) still get distinct keys.
  const seen = new Map<string, number>();
  const keyedBlocks = visible.map((block) => {
    const count = (seen.get(block) ?? 0) + 1;
    seen.set(block, count);
    return { key: `${count}:${block}`, block };
  });
  return (
    <div className="flex flex-col gap-1.5">
      {keyedBlocks.map(({ key, block }) => (
        <ReactMarkdown
          key={key}
          remarkPlugins={[remarkGfm]}
          components={components}
          urlTransform={defaultUrlTransform}
        >
          {block}
        </ReactMarkdown>
      ))}
      {hidden > 0 ? (
        <span className="text-xs">
          <InlineButton tone="muted" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Less" : `More (${hidden})`}
          </InlineButton>
        </span>
      ) : null}
    </div>
  );
});
