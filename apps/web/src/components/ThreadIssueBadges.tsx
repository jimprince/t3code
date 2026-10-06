import type { EmbeddedPage, ThreadIssueLink } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheckIcon, CircleDotIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useEmbeddedPages } from "./embeddedPages/useEmbeddedPages";
import { InlineButton } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import type { ProjectReturnLocation } from "./orchestrators/projectNavigation";
import { projectReturnState } from "./orchestrators/projectNavigation";

const STATUS_BOARD_ORIGIN = "https://control.bradleyprince.com:8450";

export type ThreadIssueBadgeTarget =
  | {
      readonly kind: "embedded";
      readonly pageId: string;
      readonly repo: string;
      readonly issue: string;
    }
  | { readonly kind: "external"; readonly url: string };

export function resolveThreadIssueBadgeTarget(
  pages: readonly EmbeddedPage[],
  issue: Pick<ThreadIssueLink, "repository" | "number" | "url">,
): ThreadIssueBadgeTarget {
  const board = pages.find((page) => {
    try {
      return new URL(page.url).origin === STATUS_BOARD_ORIGIN;
    } catch {
      return false;
    }
  });
  if (!board) return { kind: "external", url: issue.url };
  return {
    kind: "embedded",
    pageId: board.id,
    repo: issue.repository.split("/").at(-1) ?? issue.repository,
    issue: String(issue.number),
  };
}

export function ThreadIssueBadges({
  issues,
  projectReturn,
}: {
  readonly issues: readonly ThreadIssueLink[];
  readonly projectReturn?: ProjectReturnLocation;
}) {
  const pages = useEmbeddedPages();
  const navigate = useNavigate();
  return issues.map((issue) => {
    const target = resolveThreadIssueBadgeTarget(pages, issue);
    const open = issue.snapshot.state === "open";
    const Icon = open ? CircleDotIcon : CircleCheckIcon;
    const label = `${issue.repository} issue #${issue.number}: ${issue.snapshot.title} (${issue.snapshot.state})`;
    const onClick = (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (target.kind === "embedded") {
        event.preventDefault();
        void navigate({
          to: "/embedded/$pageId",
          params: { pageId: target.pageId },
          search: { repo: target.repo, issue: target.issue },
          ...(projectReturn ? { state: projectReturnState(projectReturn) } : {}),
        });
      }
    };
    return (
      <Tooltip key={`${issue.host}/${issue.repository}#${issue.number}`}>
        <TooltipTrigger
          render={
            <InlineButton
              render={
                target.kind === "external" ? (
                  <a href={target.url} target="_blank" rel="noopener noreferrer" />
                ) : (
                  <button type="button" />
                )
              }
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onClick}
            />
          }
        >
          <span className={open ? "contents text-info" : "contents text-muted-foreground"}>
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="text-xs tabular-nums">#{issue.number}</span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  });
}
