import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProjectIssue, ProjectRequestStage } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  decideProjectRequest,
  projectIssuesQuery,
  settleProjectRequest,
} from "../../state/projectIssues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { projectReturnState } from "./projectNavigation";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { useNextReleaseItems } from "./ProjectRoadmapWidget";
import { TaskTitle } from "./TaskLink";
import { RequestKindTag } from "./RequestKindTag";
import {
  answerSentences,
  deriveCompleted,
  deriveMaintenance,
  deriveNeedsYou,
  deriveProjectRequests,
  FOR_YOU_GROUPS,
  isBug,
  isMaintenanceWithAgents,
  issueKey,
  latestProgressLine,
  needsYouDecision,
  type NeedsYouDecision,
  nextReleaseRequests,
  requestsByWorker,
  requestsOfSettledThreads,
  STAGE_STATUS,
  TASK_STATUS_LABEL,
  taskKind,
  taskStatuses,
  type CompletedTask,
  type NeedsYouItem,
  type ProjectRequest,
} from "./projectRequests.logic";

/** One status word per request stage, the same words as Tasks, Roadmap and Needs you. */
const STAGE_LABEL: Record<ProjectRequestStage, string> = {
  requested: TASK_STATUS_LABEL[STAGE_STATUS.requested],
  "in-progress": TASK_STATUS_LABEL[STAGE_STATUS["in-progress"]],
  ready: TASK_STATUS_LABEL[STAGE_STATUS.ready],
  "awaiting-release": TASK_STATUS_LABEL[STAGE_STATUS["awaiting-release"]],
  "needs-test": TASK_STATUS_LABEL[STAGE_STATUS["needs-test"]],
  settled: TASK_STATUS_LABEL[STAGE_STATUS.settled],
};

/**
 * The project's requests, issues and queued filings from one shared query: the
 * Needs you, Requests, Release and Roadmap widgets and the worker rows all read this.
 */
export function useProjectRequests(summary: OrchestratorSummary, includeLater = false) {
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
      includeLater,
    );
  }, [includeLater, now, query.data, summary.descendants, summary.root]);
  return { query, requests, now, pending: query.data?.pendingRequests ?? [] };
}

/**
 * Every task's status (Pending, Active, For review, Complete), from the same
 * sources for the Tasks board, the Roadmap and Needs you.
 */
export function useTaskStatuses(summary: OrchestratorSummary) {
  const { items, query } = useNeedsYou(summary);
  const statuses = useMemo(
    () =>
      taskStatuses(
        query.data?.issues ?? [],
        items,
        [summary.root, ...summary.descendants],
        summary.root.id,
      ),
    [items, query.data, summary.descendants, summary.root],
  );
  return { statuses, query };
}

/** What waits on Brad: the same list for the Dashboard and the Tasks board. */
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

/** How long a one-click action waits, with Undo on offer, before it is sent. */
const UNDO_MS = 5000;

interface QueuedAction {
  readonly key: string;
  readonly label: string;
  readonly send: () => Promise<boolean>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * One-click actions that leave their row at once but are only sent after a few
 * seconds, so Undo is a client-side cancel. Leaving the page sends what is queued.
 */
export function useUndoableActions() {
  const queue = useRef(new Map<string, QueuedAction>());
  const [queued, setQueued] = useState<ReadonlyArray<{ key: string; label: string }>>([]);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const forget = (key: string) => {
    queue.current.delete(key);
    setQueued((current) => current.filter((entry) => entry.key !== key));
  };
  const bring = (key: string) =>
    setGone((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  const fire = (key: string) => {
    const action = queue.current.get(key);
    if (!action) return;
    clearTimeout(action.timer);
    forget(key);
    void action.send().then((sent) => {
      if (!sent) bring(key);
    });
  };
  const fireRef = useRef(fire);
  useEffect(() => {
    fireRef.current = fire;
  });
  useEffect(
    () => () => {
      for (const key of Array.from(queue.current.keys())) fireRef.current(key);
    },
    [],
  );
  return {
    queued,
    isGone: (key: string) => gone.has(key),
    run: (key: string, label: string, send: () => Promise<boolean>) => {
      if (queue.current.has(key)) return;
      setGone((current) => new Set([...current, key]));
      setQueued((current) => [...current, { key, label }]);
      queue.current.set(key, { key, label, send, timer: setTimeout(() => fire(key), UNDO_MS) });
    },
    undo: (key: string) => {
      const action = queue.current.get(key);
      if (!action) return;
      clearTimeout(action.timer);
      forget(key);
      bring(key);
    },
  };
}

/** What is waiting to be sent, each with its Undo. */
function UndoLines({ actions }: { readonly actions: ReturnType<typeof useUndoableActions> }) {
  if (actions.queued.length === 0) return null;
  return (
    <ul className="mt-2 border-t border-border pt-1">
      {actions.queued.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2 py-0.5 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.label}</span>
          <Button size="xs" variant="ghost-muted" onClick={() => actions.undo(entry.key)}>
            <RotateCcwIcon />
            Undo
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** What became of a decision: sent (and whether a thread was told), or the server's reason it was not. */
export type DecideOutcome =
  | { readonly sent: true; readonly notified: boolean }
  | { readonly sent: false; readonly error: string };

/** Brad's decisions on Needs you rows and decision cards: approve, not yet, an option or an answer. */
export function useDecide(summary: OrchestratorSummary, refresh: () => void) {
  const decide = useAtomCommand(decideProjectRequest, "Decide");
  return async (
    issue: ProjectIssue,
    decision: "approve" | "not-yet" | "option" | "answer",
    extra: { readonly option?: string; readonly answer?: string; readonly reason?: string },
  ): Promise<DecideOutcome> => {
    const result = await decide({
      environmentId: summary.root.environmentId,
      input: {
        threadId: summary.root.id,
        reference: `${issue.repository}#${issue.number}`,
        decision,
        ...extra,
      },
    });
    refresh();
    if (result._tag === "Success") {
      return { sent: true, notified: result.value.notifiedThreadId !== null };
    }
    const error = squashAtomCommandFailure(result);
    return {
      sent: false,
      error:
        error instanceof Error && error.message ? error.message : "Could not reach the server.",
    };
  };
}

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

/** The newest progress line an agent recorded on the request's issue. */
function LatestProgress({ request }: { readonly request: ProjectRequest }) {
  const line = latestProgressLine(request.issue.latestComment?.body);
  return line ? <span className="truncate text-xs text-foreground/80">{line}</span> : null;
}

function IssueLink({ issue }: { readonly issue: ProjectIssue }) {
  return (
    <TaskTitle
      task={{ host: issue.host, repository: issue.repository, number: issue.number }}
      url={issue.url}
      className="line-clamp-2 text-sm hover:underline"
    >
      {issue.title}
    </TaskTitle>
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
        <LatestProgress request={request} />
      </span>
      <RequestKindTag kind={request.kind} bug={request.bug} />
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
        {formatIssueAge(request.issue.createdAt, now)}
      </span>
      {children}
    </ClickableRow>
  );
}

/** "07:12" today, "Oct 4, 07:12" before: when a question was asked or answered. */
function clockTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * The body of a Needs you row, answer first: an answered question shows its own
 * answer in a few whole sentences with when it was asked and answered; work for
 * review shows the agent's summary; shipped work shows its test step. No meta line.
 */
function NeedsYouRowBody({
  issue,
  request,
  group,
  decision = null,
}: {
  readonly issue: ProjectIssue;
  readonly request: ProjectRequest | null;
  readonly group: NeedsYouItem["group"];
  readonly decision?: NeedsYouDecision | null;
}) {
  if (decision) {
    return (
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm">{issue.title}</span>
        {decision.summary ? (
          <span className="mt-1 line-clamp-2 block text-sm text-foreground/85">
            {decision.summary}
          </span>
        ) : null}
        {decision.recommendation ? (
          <span className="mt-0.5 block text-xs text-foreground/90">
            Recommended: {decision.recommendation}
          </span>
        ) : null}
        {decision.options.map((option) => (
          <span key={option.label} className="block truncate text-xs text-muted-foreground">
            {option.label}: {option.text}
          </span>
        ))}
      </span>
    );
  }
  // A ready comment is the agent's answer or summary; otherwise the thread's reply
  // to this very question.
  const ready = request?.stage === "ready" || request === null;
  const answer =
    ready && issue.latestComment
      ? { text: issue.latestComment.body, at: issue.latestComment.createdAt }
      : issue.answer
        ? { text: issue.answer.text, at: issue.answer.answeredAt }
        : null;
  return (
    <span className="min-w-0 flex-1">
      <IssueLink issue={issue} />
      <RequestKindTag kind={taskKind(issue.labels)} bug={isBug(issue.labels)} />
      {group === "test" ? (
        <span className="mt-1 block text-xs text-foreground/90">
          {request?.testStep ? `Test: ${request.testStep}` : "No test step posted"}
          {issue.milestone ? (
            <span className="text-muted-foreground"> · shipped in {issue.milestone.title}</span>
          ) : null}
        </span>
      ) : answer ? (
        <>
          <span className="mt-1 block text-sm text-foreground/85">
            {answerSentences(answer.text.replace(/^\s*(progress|test):\s*/i, ""))}
          </span>
          {group === "answers" ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Asked {clockTime(issue.answer?.askedAt ?? issue.createdAt)} · As of{" "}
              {clockTime(answer.at)}
            </span>
          ) : null}
        </>
      ) : null}
    </span>
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
  refresh,
}: {
  readonly summary: OrchestratorSummary;
  readonly items: ReadonlyArray<NeedsYouItem>;
  readonly settle: SettleControls;
  readonly refresh: () => void;
}) {
  const openThread = useOpenThread(summary);
  const actions = useUndoableActions();
  const decide = useDecide(summary, refresh);
  return (
    <>
      {FOR_YOU_GROUPS.map(({ group, title }) => {
        const groupItems = items.filter(
          (item) => item.group === group && !actions.isGone(issueKey(item.issue)),
        );
        if (groupItems.length === 0) return null;
        return (
          <div key={group} className="mb-3 last:mb-0">
            <GroupTitle title={title} count={groupItems.length} />
            <ul className="divide-y divide-border">
              {groupItems.map((item) => {
                const { issue, request } = item;
                const key = issueKey(issue);
                const threadId = threadOf(issue, request);
                const decision = needsYouDecision(item);
                return (
                  <ClickableRow
                    key={key}
                    label={`Open the thread for ${issue.title}`}
                    onOpen={threadId ? () => openThread(threadId) : null}
                    className="items-start py-2"
                  >
                    <NeedsYouRowBody
                      issue={issue}
                      request={request}
                      group={group}
                      decision={decision}
                    />
                    {decision ? (
                      <DecisionActions
                        decision={decision}
                        onDecide={(kind, extra) =>
                          actions.run(
                            key,
                            kind === "approve"
                              ? "Approved"
                              : kind === "not-yet"
                                ? "Not yet"
                                : (extra.option ?? "Chosen"),
                            async () => (await decide(issue, kind, extra)).sent,
                          )
                        }
                      />
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={settle.isBusy(issue)}
                        onClick={() =>
                          actions.run(key, "Settled", async () => {
                            await settle.settle([issue]);
                            return true;
                          })
                        }
                      >
                        <CheckIcon />
                        Settle
                      </Button>
                    )}
                  </ClickableRow>
                );
              })}
            </ul>
          </div>
        );
      })}
      <UndoLines actions={actions} />
    </>
  );
}

/** Approve, Not yet (with an optional one-line reason) and a button per option. */
function DecisionActions({
  decision,
  onDecide,
}: {
  readonly decision: NeedsYouDecision;
  readonly onDecide: (
    kind: "approve" | "not-yet" | "option",
    extra: { readonly option?: string; readonly reason?: string },
  ) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <span className="flex w-52 shrink-0 flex-col gap-1">
      <span className="flex flex-wrap gap-1">
        {decision.options.length === 0 ? (
          <Button size="xs" variant="outline" onClick={() => onDecide("approve", {})}>
            <CheckIcon />
            Approve
          </Button>
        ) : (
          decision.options.map((option) => (
            <Button
              key={option.label}
              size="xs"
              variant="outline"
              onClick={() => onDecide("option", { option: `${option.label}: ${option.text}` })}
            >
              {option.label}
            </Button>
          ))
        )}
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => onDecide("not-yet", reason.trim() ? { reason: reason.trim() } : {})}
        >
          Not yet
        </Button>
      </span>
      <Input
        size="sm"
        value={reason}
        maxLength={500}
        placeholder="Reason (optional)"
        aria-label="Reason for not yet"
        onChange={(event) => setReason(event.target.value)}
      />
    </span>
  );
}

/**
 * The Requests widget: Brad's asks still with the agents or waiting for a
 * release (what needs him is in Needs you). Requests whose thread he already
 * settled, and threads with several open requests, settle in one click.
 */
export function ProjectRequestsSection({
  summary,
  includeLater = false,
}: {
  readonly summary: OrchestratorSummary;
  readonly includeLater?: boolean;
}) {
  const { query, requests, now, pending } = useProjectRequests(summary, includeLater);
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
                {item.kind ? (
                  <RequestKindTag kind={item.kind} bug={item.bug === true} className="text-xs" />
                ) : (
                  <span className="text-xs">not split yet</span>
                )}
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
                <span className="min-w-0 flex-1 truncate text-sm">{group.title}</span>
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
        {task.toTest ? TASK_STATUS_LABEL["for-review"] : TASK_STATUS_LABEL.complete}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <IssueLink issue={task.issue} />
        {task.toTest ? (
          <span className="truncate text-xs text-foreground/90">
            {task.toTest.testStep ? `Test: ${task.toTest.testStep}` : "No test step posted"}
          </span>
        ) : null}
      </span>
      <RequestKindTag kind={task.kind} bug={task.bug} />
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
 * them; settled ones can be reopened), then what is built and awaiting release.
 * The next release's own items live in "Where we're going".
 */
export function ProjectReleaseWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, requests, now } = useProjectRequests(summary);
  const settle = useSettle(summary, query.refresh);
  const completed = useMemo(() => {
    const threadIds = new Set([summary.root.id, ...summary.descendants.map((thread) => thread.id)]);
    return deriveCompleted(query.data?.issues ?? [], requests, threadIds);
  }, [query.data, requests, summary.descendants, summary.root.id]);
  const awaiting = useMemo(() => nextReleaseRequests(requests), [requests]);
  const completedCount = completed.reduce((total, group) => total + group.items.length, 0);
  if (awaiting.length === 0 && completedCount === 0) return null;
  return (
    <section className="border-t border-border pt-4">
      <WidgetHeading title="Release" count={awaiting.length + completedCount} />
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
      {awaiting.length > 0 ? (
        <div className="mb-3">
          <GroupTitle title="Awaiting release" count={awaiting.length} />
          <ul className="divide-y divide-border">
            {awaiting.map((request) => (
              <CompactRow key={issueKey(request.issue)} request={request} now={now} onOpen={null} />
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
export function ProjectMaintenanceWidget({
  summary,
  includeLater = false,
}: {
  readonly summary: OrchestratorSummary;
  readonly includeLater?: boolean;
}) {
  const { query, requests, now } = useProjectRequests(summary, includeLater);
  const openThread = useOpenThread(summary);
  const tasks = useMemo(
    () => deriveMaintenance(query.data?.issues ?? [], requests, includeLater),
    [includeLater, query.data, requests],
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
                {TASK_STATUS_LABEL[task.issue.status === "in-progress" ? "active" : "pending"]}
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

/** "for: <request>" under a worker row: which of Brad's asks the worker serves. */
export function WorkerRequestTag({
  summary,
  threadId,
}: {
  readonly summary: OrchestratorSummary;
  readonly threadId: string;
}) {
  const { requests } = useProjectRequests(summary);
  const served = useMemo(
    () => requestsByWorker(requests).get(threadId) ?? [],
    [requests, threadId],
  );
  if (served.length === 0) return null;
  return (
    <span className="mt-0.5 block truncate text-xs text-foreground/80">
      for: {served.map((request) => request.issue.title).join(" · ")}
    </span>
  );
}
