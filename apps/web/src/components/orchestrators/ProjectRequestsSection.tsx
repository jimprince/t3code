import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectIssue, ProjectRequestStage } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useThreadDetail } from "../../state/entities";
import { projectIssuesQuery, settleProjectRequest } from "../../state/projectIssues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { projectReturnState } from "./projectNavigation";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { useNextReleaseItems } from "./ProjectRoadmapWidget";
import {
  deriveCompleted,
  deriveMaintenance,
  deriveNeedsYou,
  deriveProjectRequests,
  FOR_YOU_GROUPS,
  isMaintenanceWithAgents,
  issueKey,
  latestProgressLine,
  nextReleaseRequests,
  requestsOfSettledThreads,
  taskKind,
  type CompletedTask,
  type NeedsYouItem,
  type ProjectRequest,
} from "./projectRequests.logic";

const EXCERPT_LINES = 4;

/** One word per status, the same everywhere on the page. */
const STAGE_LABEL: Record<ProjectRequestStage, string> = {
  requested: "requested",
  "in-progress": "working",
  ready: "ready",
  "awaiting-release": "waiting for release",
  "needs-test": "shipped, test it",
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
 * Needs you, Requests, Release and Roadmap widgets and the worker rows all read this.
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

/** What waits on Brad: the same list for the Dashboard and the Issues board. */
export function useNeedsYou(summary: OrchestratorSummary) {
  const { query, requests } = useProjectRequests(summary);
  const items = useMemo(
    () => deriveNeedsYou(query.data?.issues ?? [], requests),
    [query.data, requests],
  );
  return { items, query };
}

/**
 * Settling and reopening are Brad's actions; every row offers them, so closing an
 * item never means opening its thread. Several issues settle one after another.
 */
export function useSettle(summary: OrchestratorSummary, refresh: () => void) {
  const settle = useAtomCommand(settleProjectRequest, "Settle");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const run = async (issues: ReadonlyArray<ProjectIssue>, reopen: boolean) => {
    const keys = issues.map(issueKey);
    setBusy((current) => new Set([...current, ...keys]));
    for (const issue of issues) {
      await settle({
        environmentId: summary.root.environmentId,
        input: {
          rootThreadId: summary.root.id,
          host: issue.host,
          repository: issue.repository,
          number: issue.number,
          ...(reopen ? { reopen: true } : {}),
        },
      });
    }
    setBusy((current) => new Set([...current].filter((key) => !keys.includes(key))));
    refresh();
  };
  return {
    isBusy: (issue: ProjectIssue) => busy.has(issueKey(issue)),
    settle: (issues: ReadonlyArray<ProjectIssue>) => run(issues, false),
    reopen: (issue: ProjectIssue) => run([issue], true),
  };
}

export type SettleControls = ReturnType<typeof useSettle>;

/** Opens a thread of the project, coming back to the project page afterwards. */
export function useOpenThread(summary: OrchestratorSummary) {
  const navigate = useNavigate();
  return (threadId: string) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(
          summary.root.environmentId,
          threadId as Parameters<typeof scopeThreadRef>[1],
        ),
      ),
      state: projectReturnState({
        environmentId: summary.root.environmentId,
        threadId: summary.root.id,
      }),
    });
}

/**
 * A list row that opens its thread when clicked anywhere: a stretched button
 * under the content, with links and buttons inside the row still on top.
 */
export function ClickableRow({
  label,
  onOpen,
  className = "",
  children,
}: {
  readonly label: string;
  /** Null when the row has no thread to open. */
  readonly onOpen: (() => void) | null;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <li className={`relative ${onOpen ? "rounded-sm hover:bg-muted/30" : ""}`}>
      {onOpen ? (
        <button
          type="button"
          aria-label={label}
          className="absolute inset-0 z-0 cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          onClick={onOpen}
        />
      ) : null}
      <div
        className={`relative z-10 flex gap-3 ${onOpen ? "pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto" : ""} ${className}`}
      >
        {children}
      </div>
    </li>
  );
}

/** The thread's newest reply, for a request whose thread answered before the agent marked it. */
function ThreadReply({
  environmentId,
  request,
}: {
  readonly environmentId: EnvironmentId;
  readonly request: ProjectRequest;
}) {
  const detail = useThreadDetail(
    request.thread ? scopeThreadRef(environmentId, request.thread.id) : null,
  );
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

/** The newest progress line an agent recorded on the request's issue. */
function LatestProgress({ request }: { readonly request: ProjectRequest }) {
  const line = latestProgressLine(request.issue.latestComment?.body);
  return line ? <span className="truncate text-xs text-foreground/80">latest: {line}</span> : null;
}

function IssueLink({ issue }: { readonly issue: ProjectIssue }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="line-clamp-2 text-sm hover:underline"
    >
      {issue.title}
    </a>
  );
}

export function SettleButton({
  issues,
  settle,
  label = "Settle",
}: {
  readonly issues: ReadonlyArray<ProjectIssue>;
  readonly settle: SettleControls;
  readonly label?: string;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={issues.some(settle.isBusy)}
      onClick={() => void settle.settle(issues)}
    >
      <CheckIcon />
      {label}
    </Button>
  );
}

export function ReopenButton({
  issue,
  settle,
}: {
  readonly issue: ProjectIssue;
  readonly settle: SettleControls;
}) {
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      disabled={settle.isBusy(issue)}
      onClick={() => void settle.reopen(issue)}
    >
      <RotateCcwIcon />
      Reopen
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

const threadOf = (issue: ProjectIssue, request: ProjectRequest | null) =>
  request?.thread?.id ?? issue.requestSource?.threadId ?? issue.linkedThreadIds[0] ?? null;

function CompactRow({
  request,
  now,
  onOpen,
  children,
}: {
  readonly request: ProjectRequest;
  readonly now: number;
  readonly onOpen: ((threadId: string) => void) | null;
  readonly children?: ReactNode;
}) {
  const threadId = threadOf(request.issue, request);
  return (
    <ClickableRow
      label={`Open the thread for ${request.issue.title}`}
      onOpen={onOpen && threadId ? () => onOpen(threadId) : null}
      className="items-center py-1.5"
    >
      <span
        className={`w-28 shrink-0 text-xs ${request.leftBehind ? "text-warning-foreground" : "text-muted-foreground"}`}
      >
        {request.leftBehind ? "left behind" : STAGE_LABEL[request.stage]}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <IssueLink issue={request.issue} />
        <ServedBy request={request} />
        <LatestProgress request={request} />
      </span>
      <span className="text-xs text-muted-foreground">{request.kind}</span>
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
        {formatIssueAge(request.issue.createdAt, now)}
      </span>
      {children}
    </ClickableRow>
  );
}

/**
 * Brad's part of Needs you: requests in his groups (answers, review, approve,
 * shipped to test) and any other issue marked for his review or test, each with
 * its answer or test step and a Settle on the row.
 */
export function NeedsYouIssueGroups({
  summary,
  items,
  settle,
}: {
  readonly summary: OrchestratorSummary;
  readonly items: ReadonlyArray<NeedsYouItem>;
  readonly settle: SettleControls;
}) {
  const environmentId = summary.root.environmentId;
  const openThread = useOpenThread(summary);
  return (
    <>
      {FOR_YOU_GROUPS.map(({ group, title }) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) return null;
        return (
          <div key={group} className="mb-3 last:mb-0">
            <GroupTitle title={title} count={groupItems.length} />
            <ul className="divide-y divide-border">
              {groupItems.map(({ issue, request }) => {
                const threadId = threadOf(issue, request);
                return (
                  <ClickableRow
                    key={issueKey(issue)}
                    label={`Open the thread for ${issue.title}`}
                    onOpen={threadId ? () => openThread(threadId) : null}
                    className="items-start py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <IssueLink issue={issue} />
                      <span className="text-xs text-muted-foreground">
                        {request ? STAGE_LABEL[request.stage] : "review"}
                        {` · ${request?.kind ?? taskKind(issue.labels) ?? "issue"}`}
                        {request?.stage === "needs-test" && issue.milestone
                          ? ` · shipped in ${issue.milestone.title}`
                          : ""}
                        {request?.replied ? " · thread replied" : ""}
                      </span>
                      {request?.testStep ? (
                        <p className="mt-1 text-xs text-foreground/90">Test: {request.testStep}</p>
                      ) : issue.latestComment ? (
                        <Excerpt text={issue.latestComment.body} />
                      ) : request?.replied ? (
                        <ThreadReply environmentId={environmentId} request={request} />
                      ) : null}
                    </span>
                    <SettleButton issues={[issue]} settle={settle} />
                  </ClickableRow>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/**
 * The Requests widget: Brad's asks still with the agents or waiting for a
 * release (what needs him is in Needs you). Requests whose thread he already
 * settled, and threads with several open requests, settle in one click.
 */
export function ProjectRequestsSection({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, requests, now, pending } = useProjectRequests(summary);
  const settle = useSettle(summary, query.refresh);
  const openThread = useOpenThread(summary);
  // Needs you shows Brad's groups; Maintenance shows upkeep still with the agents.
  const listed = requests.filter(
    (request) => request.forYou === null && !isMaintenanceWithAgents(request),
  );
  const settledThreads = requestsOfSettledThreads(listed);
  const settledKeys = new Set(
    settledThreads.flatMap((group) => group.requests.map((request) => issueKey(request.issue))),
  );
  const active = listed.filter((request) => !settledKeys.has(issueKey(request.issue)));
  const waitingForRelease = active.filter((request) => request.stage === "awaiting-release");
  const withAgents = active.filter((request) => request.stage !== "awaiting-release");
  const byThread = new Map<string, { title: string; requests: ProjectRequest[] }>();
  for (const request of withAgents) {
    if (!request.thread || request.thread.id === summary.root.id) continue;
    const entry = byThread.get(request.thread.id) ?? { title: request.thread.title, requests: [] };
    entry.requests.push(request);
    byThread.set(request.thread.id, entry);
  }
  const bulk = [...byThread.values()].filter((entry) => entry.requests.length > 1);
  if (listed.length === 0 && pending.length === 0) return null;

  return (
    <section className="border-t border-border pt-4">
      <WidgetHeading title="Requests" count={listed.length + pending.length} />
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
      {settledThreads.length > 0 ? (
        <div className="mb-3">
          <GroupTitle
            title="From settled threads"
            count={settledThreads.reduce((total, group) => total + group.requests.length, 0)}
          />
          <ul className="divide-y divide-border">
            {settledThreads.map((group) => (
              <li key={group.thread.id} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">{group.thread.title}</span>
                <span className="text-xs text-muted-foreground">{group.requests.length} open</span>
                <SettleButton
                  issues={group.requests.map((request) => request.issue)}
                  settle={settle}
                  label="Settle all"
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {waitingForRelease.length > 0 ? (
        <div className="mb-3">
          <GroupTitle title="Waiting for release" count={waitingForRelease.length} />
          <ul className="divide-y divide-border">
            {waitingForRelease.map((request) => (
              <CompactRow
                key={issueKey(request.issue)}
                request={request}
                now={now}
                onOpen={openThread}
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
                key={issueKey(request.issue)}
                request={request}
                now={now}
                onOpen={openThread}
              >
                <SettleButton issues={[request.issue]} settle={settle} />
              </CompactRow>
            ))}
          </ul>
          {bulk.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {bulk.map((entry) => (
                <li
                  key={entry.title}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {entry.requests.length} requests from {entry.title}
                  </span>
                  <SettleButton
                    issues={entry.requests.map((request) => request.issue)}
                    settle={settle}
                    label="Settle all"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** One completed task: shipped and waiting for Brad's test, or settled. */
function CompletedRow({
  task,
  now,
  settle,
}: {
  readonly task: CompletedTask;
  readonly now: number;
  readonly settle: SettleControls;
}) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span
        className={`w-28 shrink-0 text-xs ${task.toTest ? "text-foreground/90" : "text-muted-foreground"}`}
      >
        {task.toTest ? "shipped, test it" : task.issue.isRequest ? "settled" : "closed"}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <IssueLink issue={task.issue} />
        {task.toTest ? (
          <span className="truncate text-xs text-foreground/90">
            {task.toTest.testStep ? `Test: ${task.toTest.testStep}` : "No test step posted"}
          </span>
        ) : null}
      </span>
      {task.kind ? <span className="text-xs text-muted-foreground">{task.kind}</span> : null}
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
        {formatIssueAge(task.issue.closedAt ?? task.issue.updatedAt, now)}
      </span>
      {task.toTest ? (
        <SettleButton issues={[task.issue]} settle={settle} />
      ) : (
        <ReopenButton issue={task.issue} settle={settle} />
      )}
    </li>
  );
}

/**
 * The Release widget, derived from stages and milestones: completed tasks by the
 * release that shipped them (shipped ones wait for Brad's test until he settles
 * them; settled ones can be reopened), then what the next release will carry.
 */
export function ProjectReleaseWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, requests, now } = useProjectRequests(summary);
  const settle = useSettle(summary, query.refresh);
  const completed = useMemo(() => {
    const threadIds = new Set([summary.root.id, ...summary.descendants.map((thread) => thread.id)]);
    return deriveCompleted(query.data?.issues ?? [], requests, threadIds);
  }, [query.data, requests, summary.descendants, summary.root.id]);
  const next = useMemo(() => nextReleaseRequests(requests), [requests]);
  const nextVersion = useNextReleaseItems(summary);
  // The next version's items feed "Next release" too: release = milestone + stage.
  const versionOnly = nextVersion.items.filter(
    (item) =>
      !next.some(
        (request) =>
          request.issue.number === item.number &&
          request.issue.repository === requests[0]?.issue.repository,
      ),
  );
  const completedCount = completed.reduce((total, group) => total + group.items.length, 0);
  const nextCount = next.length + versionOnly.length;
  if (nextCount === 0 && completedCount === 0) return null;
  return (
    <section className="border-t border-border pt-4">
      <WidgetHeading title="Release" count={nextCount + completedCount} />
      {completed.map((group) => (
        <div key={group.release ?? ""} className="mb-3">
          <GroupTitle
            title={group.release ? `Completed in ${group.release}` : "Completed outside a release"}
            count={group.items.length}
          />
          <ul className="divide-y divide-border">
            {group.items.map((task) => (
              <CompletedRow key={issueKey(task.issue)} task={task} now={now} settle={settle} />
            ))}
          </ul>
        </div>
      ))}
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
            {next.map((request) => (
              <CompactRow key={issueKey(request.issue)} request={request} now={now} onOpen={null} />
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
    </section>
  );
}

/**
 * One line near the top of the project page: the version this server runs and
 * where the next release stands.
 */
export function ProjectReleaseLine({
  summary,
  runningVersion,
}: {
  readonly summary: OrchestratorSummary;
  readonly runningVersion: string | null;
}) {
  const { requests } = useProjectRequests(summary);
  const nextVersion = useNextReleaseItems(summary);
  const waiting = nextReleaseRequests(requests).length;
  const toTest = requests.filter((request) => request.stage === "needs-test").length;
  const running = runningVersion ? (/fork\.\d+/.exec(runningVersion)?.[0] ?? runningVersion) : null;
  const versionTitle = nextVersion.version?.title ?? null;
  const parts = [
    running ? `Running ${running}` : null,
    `Next release${
      versionTitle && versionTitle.toLowerCase() !== "next release" ? ` ${versionTitle}` : ""
    }: ${
      waiting === 0 ? "nothing waiting" : `${waiting} waiting`
    }${toTest > 0 ? `, ${toTest} shipped to test` : ""}`,
  ].filter(Boolean);
  return <span className="text-sm text-muted-foreground">{parts.join(" · ")}</span>;
}

/** Open maintenance tasks that do not need Brad: upkeep kept out of the Requests list. */
export function ProjectMaintenanceWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, requests, now } = useProjectRequests(summary);
  const openThread = useOpenThread(summary);
  const tasks = useMemo(
    () => deriveMaintenance(query.data?.issues ?? [], requests),
    [query.data, requests],
  );
  if (tasks.length === 0) return null;
  return (
    <section className="border-t border-border pt-4">
      <WidgetHeading title="Maintenance" count={tasks.length} />
      <ul className="divide-y divide-border">
        {tasks.map((task) =>
          task.request ? (
            <CompactRow
              key={issueKey(task.issue)}
              request={task.request}
              now={now}
              onOpen={openThread}
            />
          ) : (
            <ClickableRow
              key={issueKey(task.issue)}
              label={`Open the thread for ${task.issue.title}`}
              onOpen={
                task.issue.linkedThreadIds[0]
                  ? () => openThread(task.issue.linkedThreadIds[0]!)
                  : null
              }
              className="items-center py-1.5"
            >
              <span className="w-28 shrink-0 text-xs text-muted-foreground">
                {task.issue.status === "in-progress" ? "working" : "open"}
              </span>
              <span className="min-w-0 flex-1">
                <IssueLink issue={task.issue} />
              </span>
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                {formatIssueAge(task.issue.createdAt, now)}
              </span>
            </ClickableRow>
          ),
        )}
      </ul>
    </section>
  );
}
