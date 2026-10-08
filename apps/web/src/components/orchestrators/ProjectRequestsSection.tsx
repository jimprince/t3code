import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProjectIssue, ProjectRequestStage } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  decideProjectRequest,
  discussProjectRequest,
  projectIssuesQuery,
  settleProjectRequest,
} from "../../state/projectIssues";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { waitForThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { NO_OPEN_KEYS, openKeysSchema, toggleKey } from "./openGroups.logic";
import { projectReturnState } from "./projectNavigation";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { useNextReleaseItems } from "./ProjectRoadmapWidget";
import { TaskTitle } from "./TaskLink";
import { RequestKindTag } from "./RequestKindTag";
import { GroupTitle, ProjectSection, RowMenu, StatusCell } from "./ProjectSection";
import {
  deriveCompleted,
  deriveMaintenance,
  deriveNeedsYou,
  deriveProjectRequests,
  isMaintenanceWithAgents,
  issueKey,
  latestProgressLine,
  nextReleaseRequests,
  requestsOfSettledThreads,
  STAGE_STATUS,
  TASK_STATUS_LABEL,
  taskStatuses,
  type CompletedTask,
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
  /** Resolves to the first failure's reason, or null when every issue was settled (or reopened). */
  const run = async (
    issues: ReadonlyArray<ProjectIssue>,
    reopen: boolean,
  ): Promise<string | null> => {
    const keys = issues.map(issueKey);
    setBusy((current) => new Set([...current, ...keys]));
    let failed: string | null = null;
    for (const issue of issues) {
      const result = await settle({
        environmentId: summary.root.environmentId,
        input: {
          rootThreadId: summary.root.id,
          host: issue.host,
          repository: issue.repository,
          number: issue.number,
          ...(reopen ? { reopen: true } : {}),
        },
      });
      if (result._tag !== "Success" && failed === null) {
        const error = squashAtomCommandFailure(result);
        failed =
          error instanceof Error && error.message ? error.message : "Could not reach the server.";
      }
    }
    setBusy((current) => new Set([...current].filter((key) => !keys.includes(key))));
    refresh();
    return failed;
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

/**
 * Discuss on a decision: opens a thread nested under the thread waiting on it (or the
 * live one already discussing it) and goes there. `pending` names the decision whose
 * thread is being opened, so its Discuss reads Opening and ignores a second click.
 */
export function useDiscuss(summary: OrchestratorSummary) {
  const discuss = useAtomCommand(discussProjectRequest, "Discuss");
  const openThread = useOpenThread(summary);
  const [pending, setPending] = useState<string | null>(null);
  // A ref, not `pending`: a second click in the same frame still sees the old state.
  const inFlight = useRef(false);
  const start = async (issue: ProjectIssue) => {
    const key = issueKey(issue);
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(key);
    try {
      const result = await discuss({
        environmentId: summary.root.environmentId,
        input: { threadId: summary.root.id, reference: key },
      });
      if (result._tag !== "Success") return;
      // The route treats a server thread whose shell has not arrived as missing and leaves it.
      const ref = scopeThreadRef(summary.root.environmentId, result.value.threadId);
      if (await waitForThreadShell(ref)) {
        openThread(result.value.threadId);
      } else {
        toastManager.add({
          type: "error",
          title: "Could not open the discussion",
          description: "It was created; open it from the sidebar.",
        });
      }
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  return { pending, start };
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

function IssueLink({ issue }: { readonly issue: ProjectIssue }) {
  return (
    <TaskTitle
      task={{ host: issue.host, repository: issue.repository, number: issue.number }}
      url={issue.url}
      className="text-sm hover:underline"
    >
      {issue.title}
    </TaskTitle>
  );
}

/**
 * One task row: the status column, the title (wrapping, never cut) with an
 * optional note under it, the type and age, and at most one action. Below `sm`
 * the status, type and age move to a line under the title, so the title keeps
 * the width.
 */
function TaskRow({
  issue,
  status,
  statusTone = "muted",
  kind,
  bug,
  age,
  note = null,
  onOpen = null,
  action = null,
}: {
  readonly issue: ProjectIssue;
  readonly status: string;
  readonly statusTone?: "muted" | "strong" | "warning";
  readonly kind: ProjectRequest["kind"] | null;
  readonly bug: boolean;
  readonly age: string;
  /** The newest progress or test line, already cleaned. */
  readonly note?: string | null;
  readonly onOpen?: (() => void) | null;
  readonly action?: ReactNode;
}) {
  return (
    <ClickableRow
      label={`Open the thread for ${issue.title}`}
      onOpen={onOpen}
      className="items-start py-1.5"
    >
      <StatusCell tone={statusTone}>{status}</StatusCell>
      <span className="flex min-w-0 flex-1 flex-col">
        <IssueLink issue={issue} />
        {note ? <span className="line-clamp-2 text-xs text-muted-foreground">{note}</span> : null}
        <span className="text-xs text-muted-foreground sm:hidden">
          {status}
          {kind || bug ? " · " : ""}
          <RequestKindTag kind={kind} bug={bug} /> · {age}
        </span>
      </span>
      <span className="hidden shrink-0 items-baseline gap-3 pt-px sm:flex">
        <RequestKindTag kind={kind} bug={bug} />
        <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{age}</span>
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </ClickableRow>
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

const threadOf = (issue: ProjectIssue, request: ProjectRequest | null) =>
  request?.thread?.id ?? issue.requestSource?.threadId ?? issue.linkedThreadIds[0] ?? null;

/** A request as a task row; its menu settles it when Brad is done with it. */
function CompactRow({
  request,
  now,
  onOpen,
  settle = null,
}: {
  readonly request: ProjectRequest;
  readonly now: number;
  readonly onOpen: ((threadId: string) => void) | null;
  readonly settle?: SettleControls | null;
}) {
  const threadId = threadOf(request.issue, request);
  return (
    <TaskRow
      issue={request.issue}
      status={STAGE_LABEL[request.stage]}
      statusTone={request.leftBehind ? "warning" : "muted"}
      kind={request.kind}
      bug={request.bug}
      age={formatIssueAge(request.issue.createdAt, now)}
      note={latestProgressLine(request.issue.latestComment?.body)}
      onOpen={onOpen && threadId ? () => onOpen(threadId) : null}
      action={
        settle ? (
          <RowMenu
            label={request.issue.title}
            items={[
              {
                label: "Settle",
                disabled: settle.isBusy(request.issue),
                onClick: () => void settle.settle([request.issue]),
              },
            ]}
          />
        ) : null
      }
    />
  );
}

/**
 * The Requests widget: Brad's asks still with the agents (what needs him is in
 * Needs you, what awaits a release is in Release). Requests whose thread he already settled, and
 * threads with several open requests, settle in one click; any other request
 * settles from its row menu.
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
  // Needs you shows Brad's groups, Release what awaits a release, and Maintenance
  // upkeep still with the agents.
  const listed = requests.filter(
    (request) =>
      request.forYou === null &&
      request.stage !== "awaiting-release" &&
      !isMaintenanceWithAgents(request),
  );
  const settledThreads = requestsOfSettledThreads(listed);
  const settledKeys = new Set(
    settledThreads.flatMap((group) => group.requests.map((request) => issueKey(request.issue))),
  );
  const open = listed.filter((request) => !settledKeys.has(issueKey(request.issue)));
  const byThread = new Map<string, { title: string; requests: ProjectRequest[] }>();
  for (const request of open) {
    if (!request.thread || request.thread.id === summary.root.id) continue;
    const entry = byThread.get(request.thread.id) ?? { title: request.thread.title, requests: [] };
    entry.requests.push(request);
    byThread.set(request.thread.id, entry);
  }
  const bulk = [...byThread.values()].filter((entry) => entry.requests.length > 1);
  if (listed.length === 0 && pending.length === 0) return null;

  return (
    <ProjectSection title="Requests" count={listed.length + pending.length}>
      {pending.length > 0 ? (
        <div className="mb-3">
          {/* Captured but not in the tracker yet; they file themselves once it answers. */}
          <GroupTitle title="Not filed yet" count={pending.length} />
          <ul className="divide-y divide-border">
            {pending.map((item) => (
              <li
                key={`${item.messageId}:${item.title}`}
                className="flex items-start gap-3 py-1.5 text-muted-foreground"
              >
                <StatusCell>{TASK_STATUS_LABEL.pending}</StatusCell>
                <span className="min-w-0 flex-1 text-sm">{item.title}</span>
                <RequestKindTag kind={item.kind ?? null} bug={item.bug === true} />
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
                <span className="min-w-0 flex-1 text-sm">{group.title}</span>
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
      {open.length > 0 ? (
        <div>
          <GroupTitle title="Open" count={open.length} />
          <ul className="divide-y divide-border">
            {open.map((request) => (
              <CompactRow
                key={issueKey(request.issue)}
                request={request}
                now={now}
                onOpen={openThread}
                settle={settle}
              />
            ))}
          </ul>
          {bulk.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {bulk.map((entry) => (
                <li
                  key={entry.title}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="min-w-0 flex-1">
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
    </ProjectSection>
  );
}

/**
 * The Release widget: completed tasks by the release that shipped them (each can
 * be reopened from its row menu), then what is built and awaiting release. Shipped
 * work waiting for Brad's test is in Needs you, so it is not repeated here; the
 * next release's own items live in "Where we're going".
 */
export function ProjectReleaseWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const { query, requests, now } = useProjectRequests(summary);
  const settle = useSettle(summary, query.refresh);
  const completed = useMemo(() => {
    const threadIds = new Set([summary.root.id, ...summary.descendants.map((thread) => thread.id)]);
    return deriveCompleted(query.data?.issues ?? [], requests, threadIds)
      .map((group) => ({ ...group, items: group.items.filter((task) => task.toTest === null) }))
      .filter((group) => group.items.length > 0);
  }, [query.data, requests, summary.descendants, summary.root.id]);
  const awaiting = useMemo(() => nextReleaseRequests(requests), [requests]);
  // Completed groups start collapsed; the ones opened are remembered per project on this device.
  const [openReleases, setOpenReleases] = useLocalStorage(
    `t3code:projects:release-open:${summary.root.environmentId}:${summary.root.id}`,
    NO_OPEN_KEYS,
    openKeysSchema,
  );
  const completedCount = completed.reduce((total, group) => total + group.items.length, 0);
  if (awaiting.length === 0 && completedCount === 0) return null;
  return (
    <ProjectSection title="Release" count={awaiting.length + completedCount}>
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
      {completed.map((group) => {
        const key = group.release ?? "";
        const isOpen = openReleases.includes(key);
        return (
          <div key={key} className="mb-3 last:mb-0">
            <h3 className="mb-1 text-xs text-foreground/80">
              <InlineButton
                tone="muted"
                aria-expanded={isOpen}
                onClick={() => setOpenReleases((current) => toggleKey(current, key))}
              >
                {isOpen ? (
                  <ChevronDownIcon className="inline size-3" />
                ) : (
                  <ChevronRightIcon className="inline size-3" />
                )}{" "}
                {group.release ? `Completed in ${group.release}` : "Completed outside a release"}{" "}
                <span className="tabular-nums">{group.items.length}</span>
              </InlineButton>
            </h3>
            {isOpen ? (
              <ul className="divide-y divide-border">
                {group.items.map((task) => (
                  <CompletedRow key={issueKey(task.issue)} task={task} now={now} settle={settle} />
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </ProjectSection>
  );
}

/** One completed task; Reopen is in its row menu. */
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
    <TaskRow
      issue={task.issue}
      status={TASK_STATUS_LABEL.complete}
      kind={task.kind}
      bug={task.bug}
      age={formatIssueAge(task.issue.closedAt ?? task.issue.updatedAt, now)}
      action={
        <RowMenu
          label={task.issue.title}
          items={[
            {
              label: "Reopen",
              disabled: settle.isBusy(task.issue),
              onClick: () => void settle.reopen(task.issue),
            },
          ]}
        />
      }
    />
  );
}

/**
 * One line near the top of the project page: the version this server runs and
 * where the next release stands, in the page's status words.
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
  const awaiting = nextReleaseRequests(requests).length;
  const toTest = requests.filter((request) => request.stage === "needs-test").length;
  const running = runningVersion ? (/fork\.\d+/.exec(runningVersion)?.[0] ?? runningVersion) : null;
  const versionTitle = nextVersion.version?.title ?? null;
  const counts = [
    awaiting > 0 ? `${awaiting} awaiting release` : null,
    toTest > 0 ? `${toTest} ${TASK_STATUS_LABEL["for-review"].toLowerCase()}` : null,
  ].filter(Boolean);
  const parts = [
    running ? `Running ${running}` : null,
    `Next release${
      versionTitle && versionTitle.toLowerCase() !== "next release" ? ` ${versionTitle}` : ""
    }: ${counts.length > 0 ? counts.join(", ") : "nothing awaiting"}`,
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
    <ProjectSection title="Maintenance" count={tasks.length}>
      <ul className="divide-y divide-border">
        {tasks.map((task) => {
          if (task.request) {
            return (
              <CompactRow
                key={issueKey(task.issue)}
                request={task.request}
                now={now}
                onOpen={openThread}
              />
            );
          }
          const threadId = task.issue.linkedThreadIds[0];
          return (
            <TaskRow
              key={issueKey(task.issue)}
              issue={task.issue}
              status={TASK_STATUS_LABEL[task.issue.status === "in-progress" ? "active" : "pending"]}
              kind={null}
              bug={false}
              age={formatIssueAge(task.issue.createdAt, now)}
              onOpen={threadId ? () => openThread(threadId) : null}
            />
          );
        })}
      </ul>
    </ProjectSection>
  );
}
