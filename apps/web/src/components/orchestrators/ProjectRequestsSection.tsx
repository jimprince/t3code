import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useThreadProjection } from "../../state/entities";
import { projectIssuesQuery, settleProjectRequest } from "../../state/projectIssues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import {
  deriveProjectRequests,
  FOR_YOU_GROUPS,
  type ProjectRequest,
} from "./projectRequests.logic";

const EXCERPT_LINES = 4;

function excerpt(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*\*|__|`/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, EXCERPT_LINES)
    .join("\n");
}

/** The thread's newest reply, for a request whose thread answered before the agent marked it. */
function ThreadReply({
  environmentId,
  request,
}: {
  readonly environmentId: EnvironmentId;
  readonly request: ProjectRequest;
}) {
  const detail = useThreadProjection(
    request.thread ? scopeThreadRef(environmentId, request.thread.id) : null,
  )?.projection;
  const reply = useMemo(
    () =>
      detail?.messages.findLast(
        (message) => message.role === "assistant" && message.text.trim().length > 0,
      )?.text ?? null,
    [detail],
  );
  return reply ? <Excerpt text={reply} /> : null;
}

const Excerpt = ({ text }: { readonly text: string }) => (
  <p className="mt-1 line-clamp-4 text-xs whitespace-pre-line text-muted-foreground">
    {excerpt(text)}
  </p>
);

function RequestActions({
  environmentId,
  request,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly request: ProjectRequest;
  readonly children?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <span className="flex shrink-0 items-center gap-1">
      {children}
      {request.thread ? (
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, request.thread!.id)),
            })
          }
        >
          Open thread
          <ArrowUpRightIcon />
        </Button>
      ) : null}
    </span>
  );
}

/**
 * The request ledger on the project page: what Brad asked for in this project,
 * grouped by what he does next, and what is still with the agents.
 */
export function ProjectRequestsSection({ summary }: { readonly summary: OrchestratorSummary }) {
  const environmentId = summary.root.environmentId;
  const query = useEnvironmentQuery(
    projectIssuesQuery({ environmentId, input: { rootThreadId: summary.root.id } }),
  );
  const settle = useAtomCommand(settleProjectRequest, "Settle request");
  const [settling, setSettling] = useState<string | null>(null);
  const now = query.dataUpdatedAt ?? 0;
  const requests = useMemo(() => {
    const threads = [summary.root, ...summary.descendants];
    return deriveProjectRequests(
      query.data?.issues ?? [],
      threads,
      new Set(threads.map((thread) => thread.id)),
      now,
    );
  }, [now, query.data, summary.descendants, summary.root]);

  const pending = query.data?.pendingRequests ?? [];
  if (requests.length === 0 && pending.length === 0) return null;
  const waiting = requests.filter((request) => request.forYou === null);

  const settleRequest = async (request: ProjectRequest) => {
    const key = `${request.issue.repository}#${request.issue.number}`;
    setSettling(key);
    const result = await settle({
      environmentId,
      input: {
        rootThreadId: summary.root.id,
        host: request.issue.host,
        repository: request.issue.repository,
        number: request.issue.number,
      },
    });
    setSettling(null);
    if (result._tag === "Success") query.refresh();
  };

  return (
    <section className="border-t border-border pt-4">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Requests
        <span className="tabular-nums text-foreground/60">{requests.length + pending.length}</span>
      </h2>
      {pending.length > 0 ? (
        <div className="mb-3">
          <h3 className="mb-1 text-xs text-foreground/80">
            Pending filing{" "}
            <span className="tabular-nums text-muted-foreground">{pending.length}</span>
          </h3>
          <ul className="divide-y divide-border">
            {pending.map((item) => (
              <li
                key={`${item.messageId}:${item.title}`}
                className="flex items-center gap-3 py-1.5 text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                <span className="text-xs">{item.kind ?? "not split yet"}</span>
                <span className="shrink-0 text-xs">
                  {item.attempts === 0 ? "filing" : `Gitea unreachable, retry ${item.attempts}`}
                </span>
                <span className="w-8 text-right text-xs tabular-nums">
                  {formatIssueAge(item.capturedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {FOR_YOU_GROUPS.map(({ group, title }) => {
        const items = requests.filter((request) => request.forYou === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="mb-3">
            <h3 className="mb-1 text-xs text-foreground/80">
              {title} <span className="tabular-nums text-muted-foreground">{items.length}</span>
            </h3>
            <ul className="divide-y divide-border">
              {items.map((request) => {
                const key = `${request.issue.repository}#${request.issue.number}`;
                return (
                  <li key={key} className="flex items-start gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <a
                        href={request.issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate text-sm hover:underline"
                      >
                        {request.issue.title}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {request.kind} · {request.thread?.title ?? "thread not loaded"}
                        {request.replied ? " · thread replied" : ""}
                      </span>
                      {request.issue.latestComment ? (
                        <Excerpt text={request.issue.latestComment.body} />
                      ) : request.replied ? (
                        <ThreadReply environmentId={environmentId} request={request} />
                      ) : null}
                    </span>
                    <RequestActions environmentId={environmentId} request={request}>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={settling === key}
                        onClick={() => void settleRequest(request)}
                      >
                        <CheckIcon />
                        Settle
                      </Button>
                    </RequestActions>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {waiting.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs text-foreground/80">
            With agents <span className="tabular-nums text-muted-foreground">{waiting.length}</span>
          </h3>
          <ul className="divide-y divide-border">
            {waiting.map((request) => (
              <li
                key={`${request.issue.repository}#${request.issue.number}`}
                className="flex items-center gap-3 py-1.5"
              >
                <span
                  className={`w-20 shrink-0 text-xs ${request.leftBehind ? "text-warning-foreground" : "text-muted-foreground"}`}
                >
                  {request.leftBehind
                    ? "left behind"
                    : request.issue.status === "in-progress"
                      ? "in progress"
                      : "requested"}
                </span>
                <a
                  href={request.issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm hover:underline"
                >
                  {request.issue.title}
                </a>
                <span className="text-xs text-muted-foreground">{request.kind}</span>
                <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                  {formatIssueAge(request.issue.createdAt, now)}
                </span>
                <RequestActions environmentId={environmentId} request={request} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
