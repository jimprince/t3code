import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectRequestStage } from "@t3tools/contracts";
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
import { useNextReleaseItems } from "./ProjectRoadmapWidget";
import {
  deriveProjectRequests,
  deriveRelease,
  FOR_YOU_GROUPS,
  type ProjectRequest,
} from "./projectRequests.logic";

const EXCERPT_LINES = 4;

const STAGE_LABEL: Record<ProjectRequestStage, string> = {
  requested: "requested",
  "in-progress": "in progress",
  ready: "ready",
  "awaiting-release": "waiting for release",
  "needs-test": "ready to test",
  settled: "settled",
};

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

/**
 * The project's requests, issues and queued filings from one shared query: the
 * Requests, Release and Roadmap widgets and the worker rows all read this.
 */
export function useProjectRequests(summary: OrchestratorSummary) {
  const environmentId = summary.root.environmentId;
  const query = useEnvironmentQuery(
    projectIssuesQuery({ environmentId, input: { rootThreadId: summary.root.id } }),
  );
  const now = query.dataUpdatedAt ?? 0;
  const requests = useMemo(() => {
    const threads = [summary.root, ...summary.descendants];
    return deriveProjectRequests(
      query.data?.issues ?? [],
      threads,
      new Set(threads.map((thread) => thread.id)),
      now,
      summary.root.id,
    );
  }, [now, query.data, summary.descendants, summary.root]);
  return { query, requests, now, pending: query.data?.pendingRequests ?? [] };
}

/** Settling is Brad's action only; this is the one place the page does it. */
function useSettle(summary: OrchestratorSummary, refresh: () => void) {
  const settle = useAtomCommand(settleProjectRequest, "Settle request");
  const [settling, setSettling] = useState<string | null>(null);
  const run = async (request: ProjectRequest) => {
    const key = `${request.issue.repository}#${request.issue.number}`;
    setSettling(key);
    const result = await settle({
      environmentId: summary.root.environmentId,
      input: {
        rootThreadId: summary.root.id,
        host: request.issue.host,
        repository: request.issue.repository,
        number: request.issue.number,
      },
    });
    setSettling(null);
    if (result._tag === "Success") refresh();
  };
  return { settling, run };
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

function OpenThread({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(environmentId, threadId as Parameters<typeof scopeThreadRef>[1]),
          ),
        })
      }
    >
      Open thread
      <ArrowUpRightIcon />
    </Button>
  );
}

/** "-> worker, worker": who is on a request. */
function ServedBy({ request }: { readonly request: ProjectRequest }) {
  if (request.servedBy.length === 0) return null;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {"-> "}
      {request.servedBy.map((worker) => worker.title).join(", ")}
    </span>
  );
}

function IssueLink({ request }: { readonly request: ProjectRequest }) {
  return (
    <a
      href={request.issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block truncate text-sm hover:underline"
    >
      {request.issue.title}
    </a>
  );
}

function SettleButton({
  request,
  settle,
}: {
  readonly request: ProjectRequest;
  readonly settle: ReturnType<typeof useSettle>;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={settle.settling === `${request.issue.repository}#${request.issue.number}`}
      onClick={() => void settle.run(request)}
    >
      <CheckIcon />
      Settle
    </Button>
  );
}

const GroupTitle = ({ title, count }: { readonly title: string; readonly count: number }) => (
  <h3 className="mb-1 text-xs text-foreground/80">
    {title} <span className="tabular-nums text-muted-foreground">{count}</span>
  </h3>
);

const WidgetHeading = ({ title, count }: { readonly title: string; readonly count: number }) => (
  <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
    {title}
    <span className="tabular-nums text-foreground/60">{count}</span>
  </h2>
);

function CompactRow({
  request,
  now,
  children,
}: {
  readonly request: ProjectRequest;
  readonly now: number;
  readonly children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span
        className={`w-28 shrink-0 text-xs ${request.leftBehind ? "text-warning-foreground" : "text-muted-foreground"}`}
      >
        {request.leftBehind ? "left behind" : STAGE_LABEL[request.stage]}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <IssueLink request={request} />
        <ServedBy request={request} />
      </span>
      <span className="text-xs text-muted-foreground">{request.kind}</span>
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
        {formatIssueAge(request.issue.createdAt, now)}
      </span>
      {children}
    </li>
  );
}

/**
 * The Requests widget: each of Brad's asks with its stage, grouped by what is
 * next and who owns it. His groups first, then work waiting for a release, then
 * work still with the agents.
 */
export function ProjectRequestsSection({ summary }: { readonly summary: OrchestratorSummary }) {
  const environmentId = summary.root.environmentId;
  const { query, requests, now, pending } = useProjectRequests(summary);
  const settle = useSettle(summary, query.refresh);
  if (requests.length === 0 && pending.length === 0) return null;
  const waitingForRelease = requests.filter((request) => request.stage === "awaiting-release");
  const withAgents = requests.filter(
    (request) => request.forYou === null && request.stage !== "awaiting-release",
  );

  return (
    <section className="border-t border-border pt-4">
      <WidgetHeading title="Requests" count={requests.length + pending.length} />
      {pending.length > 0 ? (
        <div className="mb-3">
          <GroupTitle title="Pending filing" count={pending.length} />
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
            <GroupTitle title={title} count={items.length} />
            <ul className="divide-y divide-border">
              {items.map((request) => (
                <li
                  key={`${request.issue.repository}#${request.issue.number}`}
                  className="flex items-start gap-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <IssueLink request={request} />
                    <span className="text-xs text-muted-foreground">
                      {STAGE_LABEL[request.stage]} · {request.kind}
                      {request.stage === "needs-test" && request.issue.milestone
                        ? ` · shipped in ${request.issue.milestone.title}`
                        : ""}
                      {request.replied ? " · thread replied" : ""}
                    </span>
                    {request.testStep ? (
                      <p className="mt-1 text-xs text-foreground/90">Test: {request.testStep}</p>
                    ) : request.issue.latestComment ? (
                      <Excerpt text={request.issue.latestComment.body} />
                    ) : request.replied ? (
                      <ThreadReply environmentId={environmentId} request={request} />
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <SettleButton request={request} settle={settle} />
                    {request.thread ? (
                      <OpenThread environmentId={environmentId} threadId={request.thread.id} />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {waitingForRelease.length > 0 ? (
        <div className="mb-3">
          <GroupTitle title="Waiting for release" count={waitingForRelease.length} />
          <ul className="divide-y divide-border">
            {waitingForRelease.map((request) => (
              <CompactRow
                key={`${request.issue.repository}#${request.issue.number}`}
                request={request}
                now={now}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {withAgents.length > 0 ? (
        <div>
          <GroupTitle title="With agents" count={withAgents.length} />
          <ul className="divide-y divide-border">
            {withAgents.map((request) => (
              <CompactRow
                key={`${request.issue.repository}#${request.issue.number}`}
                request={request}
                now={now}
              >
                {request.thread ? (
                  <OpenThread environmentId={environmentId} threadId={request.thread.id} />
                ) : null}
              </CompactRow>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The Release widget, derived from request stages: what the next release batch
 * will carry, and what shipped and waits for Brad's test until he settles it.
 */
export function ProjectReleaseWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, requests, now } = useProjectRequests(summary);
  const settle = useSettle(summary, query.refresh);
  const release = useMemo(() => deriveRelease(requests), [requests]);
  const nextVersion = useNextReleaseItems(summary);
  // The next version's items feed "Next release" too: release = milestone + stage.
  const versionOnly = nextVersion.items.filter(
    (item) =>
      !release.next.some(
        (request) =>
          request.issue.number === item.number &&
          request.issue.repository === requests[0]?.issue.repository,
      ),
  );
  const shippedCount = release.shipped.reduce((total, group) => total + group.items.length, 0);
  const nextCount = release.next.length + versionOnly.length;
  if (nextCount === 0 && shippedCount === 0) return null;
  return (
    <section className="border-t border-border pt-4">
      <WidgetHeading title="Release" count={nextCount + shippedCount} />
      {nextCount > 0 ? (
        <div className="mb-3">
          <GroupTitle
            title={
              nextVersion.version && nextVersion.version.title.toLowerCase() !== "next release"
                ? `Next release (${nextVersion.version.title})`
                : "Next release"
            }
            count={nextCount}
          />
          <ul className="divide-y divide-border">
            {release.next.map((request) => (
              <CompactRow
                key={`${request.issue.repository}#${request.issue.number}`}
                request={request}
                now={now}
              />
            ))}
            {versionOnly.map((item) => (
              <li key={item.number} className="flex items-center gap-3 py-1.5">
                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                  {item.stage ? (STAGE_LABEL[item.stage] ?? item.stage) : "planned"}
                </span>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm hover:underline"
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {release.shipped.map((group) => (
        <div key={group.release} className="mb-3">
          <GroupTitle
            title={`Shipped in ${group.release}, please test`}
            count={group.items.length}
          />
          <ul className="divide-y divide-border">
            {group.items.map((request) => (
              <li
                key={`${request.issue.repository}#${request.issue.number}`}
                className="flex items-center gap-3 py-1.5"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <IssueLink request={request} />
                  <span className="truncate text-xs text-foreground/90">
                    {request.testStep ? `Test: ${request.testStep}` : "No test step posted"}
                  </span>
                </span>
                <SettleButton request={request} settle={settle} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
