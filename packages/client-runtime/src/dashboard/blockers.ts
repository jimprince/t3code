import * as DateTime from "effect/DateTime";
import type {
  DashboardAttention,
  DashboardSnapshot,
  DashboardTask,
  EnvironmentId,
  ProjectIssue,
  ThreadId,
} from "@t3tools/contracts";
import {
  retiredThreadKeys,
  blockedThreadSet,
  buildOrchestratorSummaries,
  isThreadBlocked,
  orchestratorParentKey,
  threadActivityKey,
  lastActivityAt,
  type OrchestratorSummary,
  type OrchestratorThreadShell,
} from "../state/orchestrators.ts";
import { isThreadResumable } from "../threadResume.ts";
import { stripNotifyMarker } from "../notifyMarker.ts";
import { mergeLiveAttention, type LiveRuntimeRequests } from "./liveAttention.ts";

export type BlockerAction =
  | { type: "answer"; attentionId: string }
  | { type: "resume-plan"; threadId: ThreadId }
  | { type: "resume-queue"; threadId: ThreadId }
  | { type: "settle"; threadIds: ThreadId[] }
  | { type: "open"; threadId?: ThreadId; url?: string };
export type Blocker = {
  key: string;
  kind:
    | "waiting-on-brad"
    | "failed"
    | "blocked-line"
    | "stopped"
    | "held-queue"
    | "blocked-by"
    | "usage-limit"
    | "stuck"
    | "waiting-question";
  name: string;
  reason: string | null;
  target: {
    environmentId?: EnvironmentId;
    threadId?: ThreadId;
    issueUrl?: string;
    attentionId?: string;
  };
  action: BlockerAction | null;
  /** Explains why no state-changing action is available. */
  actionReason: string | null;
  owner: { threadId: ThreadId; name: string } | null;
  /** Pass unchanged to #355's DecisionAnswerArea. */
  attention?: DashboardAttention;
};
export type BlockerPermissions = {
  canOperate?: boolean;
  canResumePlan?: boolean;
  canResumeQueue?: boolean;
  canSettle?: boolean;
  /** Explicit clock, so usage-limit behavior is deterministic. */
  now: string;
  environmentId?: EnvironmentId;
};
const line = (text: string | null | undefined) =>
  text?.trim().replace(/\s+/g, " ").slice(0, 240) || null;

/** Shared board/sidebar explanation of a worker's BLOCKED reply. */
export function workerCause(item: { latestLine: string | null }): string {
  const match = /^blocked\b[\s:,–—-]*(.*)/is.exec(stripNotifyMarker(item.latestLine ?? "").trim());
  return (match && line(match[1])) || (match ? "Blocked" : "Failed");
}

/** Exact summary set: use its length for the badge and this same list for the popover. */
export function blockerSet(
  row: OrchestratorSummary,
  options: BlockerPermissions = { now: DateTime.formatIso(DateTime.nowUnsafe()) },
): Blocker[] {
  return blockedThreadSet(row).flatMap(({ thread, owner }) =>
    describeThreadBlocker(thread, owner, options),
  );
}

/** Compatibility entry point for individual task scopes. Pass all connected environments. */
export function threadBlockers(
  shells: readonly OrchestratorThreadShell[],
  rootId: ThreadId | null,
  options: BlockerPermissions,
): Blocker[] {
  const root = shells.find(
    (shell) =>
      shell.id === rootId &&
      (!options.environmentId || shell.environmentId === options.environmentId),
  );
  const summary =
    root &&
    buildOrchestratorSummaries(shells, []).find(
      (row) => threadActivityKey(row.root) === threadActivityKey(root),
    );
  if (summary) return blockerSet(summary, options);
  const byKey = new Map(shells.map((shell) => [threadActivityKey(shell), shell]));
  const children = new Map<string, OrchestratorThreadShell[]>();
  for (const shell of shells) {
    const parent = orchestratorParentKey(shell);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), shell]);
  }
  const seen = retiredThreadKeys(shells);
  const visit = (shell: OrchestratorThreadShell, owner: OrchestratorThreadShell): Blocker[] => {
    const key = threadActivityKey(shell);
    if (seen.has(key) || /\(retired\b/i.test(shell.title)) return [];
    seen.add(key);
    if (shell.subproject === "on") owner = shell;
    return [
      ...describeThreadBlocker(shell, owner, options),
      ...(children.get(key) ?? []).flatMap((child) => visit(child, owner)),
    ];
  };
  return rootId === null
    ? [...byKey.values()].flatMap((shell) => visit(shell, shell))
    : root
      ? visit(root, root)
      : [];
}

function describeThreadBlocker(
  shell: OrchestratorThreadShell,
  owner: OrchestratorThreadShell,
  options: BlockerPermissions,
): Blocker[] {
  if (!isThreadBlocked(shell)) return [];
  const source = shell.source;
  const held = source.queueHeld === true;
  const resumable = isThreadResumable(source);
  const failed =
    shell.runtime?.status === "failed" ||
    shell.latestRun?.status === "failed" ||
    source.status === "failed";
  const output = stripNotifyMarker(source.workerSummary?.output ?? "").trim();
  const blocked = /^blocked\b/i.test(output);
  const limited = source.lastErrorClass === "usage_limit";
  const reset = source.usageLimitResetAt;
  const waitingForReset =
    limited &&
    (!reset || !Number.isFinite(Date.parse(reset)) || Date.parse(reset) > Date.parse(options.now));
  const kind = held
    ? "held-queue"
    : limited
      ? "usage-limit"
      : resumable
        ? "stopped"
        : failed
          ? "failed"
          : "blocked-line";
  let action: BlockerAction | null = held
    ? { type: "resume-queue", threadId: shell.id }
    : resumable
      ? { type: "resume-plan", threadId: shell.id }
      : failed
        ? { type: "settle", threadIds: [shell.id] }
        : null;
  let actionReason: string | null = action
    ? null
    : "This worker must resolve the blocker in its thread.";
  if (source.planResumeState?.hasLiveTurn && !held) {
    action = null;
    actionReason = "This thread still has a running turn; open it to inspect the blocker.";
  } else if (
    action?.type === "settle" &&
    (shell.id === owner.id || shell.subproject === "on" || orchestratorParentKey(shell) === null)
  ) {
    action = null;
    actionReason = "Project heads cannot be settled here; open the thread to inspect it.";
  } else if (waitingForReset) {
    action = null;
    actionReason = "Wait for the usage limit to reset before resuming.";
  } else if (options.canOperate === false) {
    action = null;
    actionReason = "Operating this thread requires operate permission.";
  } else if (
    (held && options.canResumeQueue === false) ||
    (resumable && options.canResumePlan === false) ||
    (action?.type === "settle" && options.canSettle === false)
  ) {
    action = null;
    actionReason = "This server does not support this action.";
  }
  const reason = held
    ? "Queued work is held until you resume the queue."
    : limited
      ? `Usage limit${reset ? `, resets ${reset}` : "; reset time unknown"}`
      : kind === "blocked-line"
        ? workerCause({ latestLine: output })
        : (line(source.lastError) ??
          (blocked
            ? workerCause({ latestLine: output })
            : resumable
              ? (line(source.todoProgress?.currentStep?.text) ??
                "Stopped with unfinished plan steps.")
              : "The latest run failed."));
  return [
    {
      key: `thread:${shell.environmentId}:${shell.id}`,
      kind,
      name: shell.title,
      reason,
      target: { environmentId: shell.environmentId, threadId: shell.id },
      action,
      actionReason,
      owner: { threadId: owner.id, name: owner.title },
    },
  ];
}

export type AttentionBlockers = { blockers: Blocker[]; asOf: string; stored: boolean };
/** Uses only a supplied mounted or stored snapshot. Never subscribes or fetches. */
export function attentionBlockers(
  snapshot: Pick<DashboardSnapshot, "projects" | "asOf">,
  rootId: ThreadId,
  options: {
    stored?: boolean;
    canOperate?: boolean;
    taskId?: string;
    live?: LiveRuntimeRequests;
    shells?: readonly OrchestratorThreadShell[];
    environmentId?: EnvironmentId;
  } = {},
): AttentionBlockers {
  const root = snapshot.projects.find((project) => project.rootThreadId === rootId);
  const ids = new Set(root ? [root.id] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of snapshot.projects) {
      if (project.parentId && ids.has(project.parentId) && !ids.has(project.id)) {
        ids.add(project.id);
        changed = true;
      }
    }
  }
  const seen = new Set<string>();
  const summaries = options.shells ? buildOrchestratorSummaries(options.shells, []) : [];
  const blockers = snapshot.projects
    .filter((project) => ids.has(project.id))
    .flatMap((project) => {
      const summary = summaries.find(
        (row) =>
          row.root.id === project.rootThreadId &&
          (!options.environmentId || row.root.environmentId === options.environmentId),
      );
      const threadIds = new Set([
        project.rootThreadId,
        ...project.tasks.map((task) => task.threadId),
        ...(summary ? [summary.root.id, ...summary.descendants.map((thread) => thread.id)] : []),
      ]);
      const attention =
        options.live && options.environmentId
          ? mergeLiveAttention(
              options.environmentId,
              project.attention,
              options.live,
              options.stored ? "cached" : "live",
            ).filter((item) => item.requestId === null || threadIds.has(item.threadId))
          : project.attention;
      return attention
        .filter(
          (item) =>
            !options.taskId ||
            item.taskId === options.taskId ||
            item.blockingTaskIds.includes(options.taskId),
        )
        .flatMap((item): Blocker[] => {
          if (seen.has(item.id)) return [];
          seen.add(item.id);
          const canAnswer = options.canOperate !== false && item.canRespond;
          return [
            {
              key: item.id,
              kind: "waiting-on-brad",
              name: item.title,
              reason: line(item.question),
              target: {
                ...(item.threadId ? { threadId: item.threadId } : {}),
                ...(item.url ? { issueUrl: item.url } : {}),
                attentionId: item.id,
              },
              action: canAnswer ? { type: "answer", attentionId: item.id } : null,
              actionReason: canAnswer
                ? null
                : options.canOperate === false
                  ? "Answering requires operate permission."
                  : "Open the item to respond; inline answers are unavailable.",
              owner: project.rootThreadId
                ? { threadId: project.rootThreadId, name: project.title }
                : null,
              attention: item,
            },
          ];
        });
    });
  blockers.sort((a, b) => a.attention!.priority - b.attention!.priority);
  return { blockers, asOf: snapshot.asOf, stored: options.stored === true };
}

/** Counts every waiting kind, including review and decision items after tests. */
export function blockerHeadline(blockers: readonly Blocker[]): string {
  const first = blockers[0];
  if (!first) return "Waiting on Brad: nothing";
  if (first.kind !== "waiting-on-brad")
    return `Blocked: ${first.name}${blockers.length > 1 ? ` and ${blockers.length - 1} more` : ""}`;
  const item = first.attention;
  const number = /#(\d+)(?::attention)?$/.exec(item?.taskId ?? "")?.[1];
  return `Waiting on Brad: ${number ? `${item?.kind ?? "decision"} #${number}` : `“${first.name}”`}${blockers.length > 1 ? ` and ${blockers.length - 1} more` : ""}`;
}

/** Issue dependencies are navigation only; closing the named issue clears them. */
export function issueBlockers(issue: ProjectIssue, issues: readonly ProjectIssue[]): Blocker[] {
  return (issue.blockedBy ?? []).flatMap((number) => {
    const dependency = issues.find(
      (candidate) =>
        candidate.host === issue.host &&
        candidate.repository === issue.repository &&
        candidate.number === number,
    );
    if (
      dependency &&
      (dependency.closedAt !== null ||
        dependency.status === "done" ||
        dependency.status === "archived")
    )
      return [];
    return [
      {
        key: `dependency:${issue.host}/${issue.repository}#${number}`,
        kind: "blocked-by" as const,
        name: dependency ? `#${number}: ${dependency.title}` : `#${number}`,
        reason: `Waiting for #${number} to close.`,
        target: dependency ? { issueUrl: dependency.url } : {},
        action: null,
        actionReason: "This clears when the blocking issue closes.",
        owner: null,
      },
    ];
  });
}

/** One entry per blocked project task, plus the exact thread set. Count this list directly. */
export function projectBlockerSet(
  row: OrchestratorSummary,
  issues: readonly ProjectIssue[],
  options: BlockerPermissions & { activeIssueKeys?: ReadonlySet<string> },
): Blocker[] {
  const blockers = blockerSet(row, options);
  const threads = [row.root, ...row.descendants];
  const blockedIds = new Set(blockers.map((blocker) => blocker.target.threadId));
  const issueKey = (issue: ProjectIssue) => `${issue.host}/${issue.repository}#${issue.number}`;
  for (const issue of issues) {
    if (
      issue.closedAt !== null ||
      issue.status === "done" ||
      issue.status === "archived" ||
      issue.labels.some((label) => label.toLowerCase() === "parked") ||
      !(options.activeIssueKeys
        ? options.activeIssueKeys.has(issueKey(issue))
        : issue.status === "in-progress")
    )
      continue;
    const dependencies = issueBlockers(issue, issues);
    if (dependencies.length) {
      blockers.push({
        key: `task-dependency:${issueKey(issue)}`,
        kind: "blocked-by",
        name: issue.title,
        reason: `Blocked by ${dependencies.map((blocker) => blocker.name).join(", ")}.`,
        target: dependencies[0]!.target,
        action: null,
        actionReason: "This clears when the blocking issues close.",
        owner: { threadId: row.root.id, name: row.root.title },
      });
      continue;
    }
    const workers = threads.filter(
      (thread) => thread.id !== row.root.id && issue.linkedThreadIds.includes(thread.id),
    );
    const idleMs =
      Date.parse(options.now) -
      Math.max(
        Date.parse(issue.updatedAt),
        ...workers.map((thread) => Date.parse(lastActivityAt(thread))),
      );
    if (
      !Number.isFinite(idleMs) ||
      idleMs < 3 * 86_400_000 ||
      workers.some((thread) => blockedIds.has(thread.id))
    )
      continue;
    blockers.push({
      key: `stuck:${issueKey(issue)}`,
      kind: "stuck",
      name: issue.title,
      reason: `Stuck ${Math.floor(idleMs / 86_400_000)}d: no task or linked worker activity for at least three days.`,
      target: { issueUrl: issue.url },
      action: null,
      actionReason: "Open the task to review its next step.",
      owner: { threadId: row.root.id, name: row.root.title },
    });
  }
  return blockers;
}

/** Names the actual task cause even when a stored snapshot has lost its runtime question. */
export function taskBlockers(
  task: DashboardTask,
  shells: readonly OrchestratorThreadShell[],
  issues: readonly ProjectIssue[],
  options: BlockerPermissions,
): Blocker[] {
  const shell = shells.find(
    (shell) =>
      shell.id === task.threadId &&
      (!options.environmentId || shell.environmentId === options.environmentId),
  );
  const thread = shell ? describeThreadBlocker(shell, shell, options) : [];
  if (thread.length)
    return thread.map((blocker) =>
      blocker.kind === "held-queue"
        ? { ...blocker, reason: `Queue held on ${shell!.title}.` }
        : blocker,
    );
  const issue = issues.find(
    (issue) => task.id === `issue:${issue.host}/${issue.repository}#${issue.number}`,
  );
  const dependencies = issue ? issueBlockers(issue, issues) : [];
  if (dependencies.length) return dependencies;
  if (task.status !== "blocked") return [];
  const question = task.attentionIds.length > 0 || shell?.source.pendingRuntimeRequest != null;
  return [
    {
      key: `task-wait:${task.id}`,
      kind: question ? "waiting-question" : "blocked-line",
      name: task.title,
      reason: question
        ? shell
          ? `Waiting on a question in ${shell.title} (open the thread).`
          : "Waiting on a question (open the thread)."
        : "Open the task to inspect what is blocking it.",
      target: {
        ...(shell
          ? { environmentId: shell.environmentId, threadId: shell.id }
          : task.threadId
            ? { threadId: task.threadId }
            : {}),
        ...(task.url ? { issueUrl: task.url } : {}),
      },
      action: null,
      actionReason: question
        ? "Open the thread to view the pending question."
        : "Open the task to inspect the blocker.",
      owner: null,
    },
  ];
}
