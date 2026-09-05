import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Retirement of the git worktrees T3 created for worker threads.
 *
 * A host accumulates one checkout per worker, and their dependency trees and
 * caches dominate its disk. Reclaiming them is only safe when the work they
 * hold is genuinely finished, so this plans removals from the environment's
 * thread snapshot plus the local git state and never removes a checkout that
 * still has an unarchived thread, a live turn, or any tracked or untracked
 * change.
 */

/** Structural subset of a thread shell that retirement decisions depend on. */
export interface WorktreeGcThread {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly session: { readonly status: string; readonly activeTurnId: string | null } | null;
  readonly latestTurn: { readonly state: string } | null;
}

export type WorktreeState =
  | { readonly kind: "clean" }
  | { readonly kind: "dirty"; readonly detail: string }
  | { readonly kind: "missing" }
  | { readonly kind: "not-a-linked-worktree"; readonly detail: string };

/** Resolves the local git state of one worktree path. */
export type WorktreeInspector = (path: string) => Promise<WorktreeState>;

export type RetentionReason =
  | "unarchived-thread"
  | "active-turn"
  | "recovery-window"
  | "dirty"
  | "missing"
  | "not-a-linked-worktree";

export interface WorktreeGcCandidate {
  readonly path: string;
  readonly threadIds: ReadonlyArray<string>;
  /** Newest archive time across the threads that used this checkout. */
  readonly archivedAt: string;
}

export interface WorktreeGcRetention {
  readonly path: string;
  readonly threadIds: ReadonlyArray<string>;
  readonly reason: RetentionReason;
  readonly detail?: string;
}

export interface WorktreeGcPlan {
  readonly removable: ReadonlyArray<WorktreeGcCandidate>;
  readonly retained: ReadonlyArray<WorktreeGcRetention>;
}

export const DEFAULT_RECOVERY_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function hasActiveWork(thread: WorktreeGcThread): boolean {
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    (thread.session?.activeTurnId ?? null) !== null
  );
}

async function groupByWorktreePath(
  threads: ReadonlyArray<WorktreeGcThread>,
): Promise<Map<string, WorktreeGcThread[]>> {
  const groups = new Map<string, WorktreeGcThread[]>();
  for (const thread of threads) {
    const path = thread.worktreePath?.trim();
    if (!path) {
      continue;
    }
    const normalized = await NodeFSP.realpath(path).catch(() => NodePath.resolve(path));
    const group = groups.get(normalized);
    if (group) {
      group.push(thread);
    } else {
      groups.set(normalized, [thread]);
    }
  }
  return groups;
}

/**
 * Decides which worktrees may be removed. Checks run cheapest-and-safest
 * first so a checkout that is still in use is never inspected or touched.
 */
export async function planWorktreeGc(input: {
  readonly threads: ReadonlyArray<WorktreeGcThread>;
  readonly inspect: WorktreeInspector;
  readonly now?: Date;
  readonly recoveryWindowDays?: number;
}): Promise<WorktreeGcPlan> {
  const now = (input.now ?? new Date()).getTime();
  const recoveryWindowMs =
    Math.max(0, input.recoveryWindowDays ?? DEFAULT_RECOVERY_WINDOW_DAYS) * DAY_MS;

  const removable: WorktreeGcCandidate[] = [];
  const retained: WorktreeGcRetention[] = [];

  for (const [path, group] of [...(await groupByWorktreePath(input.threads))].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const threadIds = group.map((thread) => thread.id);

    const unarchived = group.find((thread) => thread.archivedAt === null);
    if (unarchived) {
      retained.push({
        path,
        threadIds,
        reason: "unarchived-thread",
        detail: `thread ${unarchived.id} is not archived`,
      });
      continue;
    }

    const active = group.find(hasActiveWork);
    if (active) {
      retained.push({
        path,
        threadIds,
        reason: "active-turn",
        detail: `thread ${active.id} still reports active work`,
      });
      continue;
    }

    const archivedAt = group
      .map((thread) => thread.archivedAt ?? "")
      .reduce((newest, value) => (value > newest ? value : newest), "");
    const archivedAtMs = Date.parse(archivedAt);
    if (Number.isNaN(archivedAtMs) || now - archivedAtMs < recoveryWindowMs) {
      retained.push({
        path,
        threadIds,
        reason: "recovery-window",
        detail: `archived at ${archivedAt || "an unknown time"}`,
      });
      continue;
    }

    const state = await input.inspect(path);
    if (state.kind === "clean") {
      removable.push({ path, threadIds, archivedAt });
    } else {
      retained.push({
        path,
        threadIds,
        reason: state.kind,
        ...(state.kind === "missing" ? {} : { detail: state.detail }),
      });
    }
  }

  return { removable, retained };
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(args: ReadonlyArray<string>, cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        resolve({
          status: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * Inspects a path with git. Anything that is not a clean linked worktree is
 * reported rather than removed, including paths that no longer exist and the
 * repository's main worktree.
 */
export const inspectWorktree: WorktreeInspector = async (path) => {
  let gitDir: GitResult;
  try {
    gitDir = await runGit(["rev-parse", "--path-format=absolute", "--git-dir"], path);
  } catch {
    return { kind: "missing" };
  }
  if (gitDir.status !== 0) {
    return {
      kind: "not-a-linked-worktree",
      detail: gitDir.stderr.trim() || "git rev-parse failed",
    };
  }

  const commonDir = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  if (commonDir.status !== 0) {
    return {
      kind: "not-a-linked-worktree",
      detail: commonDir.stderr.trim() || "git rev-parse failed",
    };
  }

  const linkedWorktreesDir = NodePath.join(commonDir.stdout.trim(), "worktrees");
  if (!gitDir.stdout.trim().startsWith(`${linkedWorktreesDir}${NodePath.sep}`)) {
    return { kind: "not-a-linked-worktree", detail: "path is the repository's main worktree" };
  }

  const topLevel = await runGit(["rev-parse", "--show-toplevel"], path);
  if (
    topLevel.status !== 0 ||
    NodePath.resolve(topLevel.stdout.trim()) !== (await NodeFSP.realpath(path))
  ) {
    return { kind: "not-a-linked-worktree", detail: "path is not a worktree root" };
  }

  const status = await runGit(["status", "--porcelain"], path);
  if (status.status !== 0) {
    return { kind: "not-a-linked-worktree", detail: status.stderr.trim() || "git status failed" };
  }
  const changes = status.stdout.trim();
  if (changes) {
    const lines = changes.split("\n");
    const preview = lines.slice(0, 3).join("; ");
    return {
      kind: "dirty",
      detail: lines.length > 3 ? `${preview}; +${lines.length - 3} more` : preview,
    };
  }

  return { kind: "clean" };
};

export interface WorktreeRemoval {
  readonly path: string;
  readonly removed: boolean;
  readonly error?: string;
}

/**
 * Removes one planned worktree. `git worktree remove` is never forced, so git
 * independently refuses anything dirty, and the branch ref and its commits
 * survive the removal.
 */
export async function removeWorktree(path: string): Promise<WorktreeRemoval> {
  const commonDir = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  if (commonDir.status !== 0) {
    return { path, removed: false, error: commonDir.stderr.trim() || "git rev-parse failed" };
  }
  const mainWorktree = NodePath.dirname(commonDir.stdout.trim());

  const removal = await runGit(["worktree", "remove", "--", path], mainWorktree);
  if (removal.status !== 0) {
    return { path, removed: false, error: removal.stderr.trim() || "git worktree remove failed" };
  }
  return { path, removed: true };
}
