import type {
  DashboardAttention,
  DashboardSnapshot,
  ProjectIssue,
  ThreadId,
} from "@t3tools/contracts";
import type { OrchestratorThreadShell } from "../state/orchestrators.ts";
import { isThreadResumable } from "../threadResume.ts";
import { stripNotifyMarker } from "../notifyMarker.ts";

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
    | "usage-limit";
  name: string;
  reason: string | null;
  target: { threadId?: ThreadId; issueUrl?: string; attentionId?: string };
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
};
const line = (text: string | null | undefined) =>
  text?.trim().replace(/\s+/g, " ").slice(0, 240) || null;

/** Shared board/sidebar explanation of a worker's BLOCKED reply. */
export function workerCause(item: { latestLine: string | null }): string {
  const match = /^blocked\b[\s:,–—-]*(.*)/is.exec(stripNotifyMarker(item.latestLine ?? "").trim());
  return (match && line(match[1])) || (match ? "Blocked" : "Failed");
}

/** Own blockers followed by descendants, with attribution retained for parent popovers. */
export function threadBlockers(
  shells: readonly OrchestratorThreadShell[],
  rootId: ThreadId | null,
  options: BlockerPermissions,
): Blocker[] {
  const children = new Map<ThreadId, OrchestratorThreadShell[]>();
  for (const shell of shells) {
    if (shell.remoteParent || !shell.parentThreadId) continue;
    const group = children.get(shell.parentThreadId) ?? [];
    group.push(shell);
    children.set(shell.parentThreadId, group);
  }
  const ordered: OrchestratorThreadShell[] = [];
  const visited = new Set<ThreadId>();
  const visit = (shell: OrchestratorThreadShell) => {
    if (visited.has(shell.id) || shell.archivedAt !== null || shell.settledOverride === "settled")
      return;
    visited.add(shell.id);
    ordered.push(shell);
    for (const child of children.get(shell.id) ?? []) visit(child);
  };
  if (rootId === null) shells.forEach(visit);
  else {
    const root = shells.find((shell) => shell.id === rootId);
    if (root) visit(root);
  }
  const byId = new Map(shells.map((shell) => [shell.id, shell]));
  const ownerOf = (shell: OrchestratorThreadShell) => {
    let owner = shell;
    const path = new Set<ThreadId>();
    while (
      owner.id !== rootId &&
      owner.subproject !== "on" &&
      owner.parentThreadId &&
      !path.has(owner.id)
    ) {
      path.add(owner.id);
      const parent = byId.get(owner.parentThreadId);
      if (!parent) break;
      owner = parent;
    }
    return { threadId: owner.id, name: owner.title };
  };
  return ordered.flatMap((shell): Blocker[] => {
    const source = shell.source;
    const held = source.queueHeld === true;
    const active = ["preparing", "starting", "running", "waiting", "queued"].includes(
      shell.runtime?.status ?? source.status,
    );
    if (active && !held) return [];
    const resumable = isThreadResumable(source);
    const failed =
      shell.runtime?.status === "failed" ||
      shell.latestRun?.status === "failed" ||
      source.status === "failed";
    const output = stripNotifyMarker(source.workerSummary?.output ?? "").trim();
    const blocked = /^blocked\b/i.test(output);
    if (!held && !failed && !blocked && !resumable) return [];
    const limited = source.lastErrorClass === "usage_limit";
    const reset = source.usageLimitResetAt;
    const waitingForReset =
      limited &&
      (!reset ||
        !Number.isFinite(Date.parse(reset)) ||
        Date.parse(reset) > Date.parse(options.now));
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
        : (line(source.lastError) ??
          (blocked
            ? workerCause({ latestLine: output })
            : resumable
              ? (line(source.todoProgress?.currentStep?.text) ??
                "Stopped with unfinished plan steps.")
              : "The latest run failed."));
    return [
      {
        key: `thread:${shell.id}`,
        kind,
        name: shell.title,
        reason,
        target: { threadId: shell.id },
        action,
        actionReason,
        owner: ownerOf(shell),
      },
    ];
  });
}

export type AttentionBlockers = { blockers: Blocker[]; asOf: string; stored: boolean };
/** Uses only a supplied mounted or stored snapshot. Never subscribes or fetches. */
export function attentionBlockers(
  snapshot: Pick<DashboardSnapshot, "projects" | "asOf">,
  rootId: ThreadId,
  options: { stored?: boolean; canOperate?: boolean; taskId?: string } = {},
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
  const blockers = snapshot.projects
    .filter((project) => ids.has(project.id))
    .flatMap((project) =>
      project.attention
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
        }),
    );
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
  return `Waiting on Brad: ${item?.kind ?? "decision"} ${number ? `#${number}` : first.name}${blockers.length > 1 ? ` and ${blockers.length - 1} more` : ""}`;
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
    if (dependency?.status === "done") return [];
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
