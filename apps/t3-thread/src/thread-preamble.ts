import { threadSendCommand, type ThreadIdentity } from "./thread-identity.js";

/**
 * Canonical preamble injected into the initial message of every
 * `t3-thread create` invocation (unless `--no-preamble` is passed).
 *
 * Purpose: make every T3 worker thread aware that it is a T3 worker and
 * point it at the canonical skill, without duplicating the skill body
 * into every brief. Updates to the skill file propagate automatically
 * because workers re-read it on demand.
 *
 * If you change this preamble, also review:
 *   - ~/.shared/skills/t3-threads/SKILL.md (Auto-Preamble section)
 *   - any tests that assert its shape
 */
export const THREAD_PREAMBLE = [
  "You are a T3 worker thread. Before acting on the brief below, read and follow:",
  "  ~/.shared/skills/t3-threads/SKILL.md",
  "If you need to coordinate with a parent thread, use `t3-thread send <name> ...`.",
  "",
  "--- BRIEF ---",
].join("\n");

/**
 * Wrap an initial worker-thread message with the canonical preamble.
 *
 * @param message - raw brief provided by the caller via `--message`
 * @returns preamble + brief, joined with a newline
 */
export interface WorkerContext {
  name: string;
  parent: ThreadIdentity | null;
  notifyLevel: string;
}

export function wrapWithPreamble(
  message: string,
  context?: WorkerContext & {
    threadId: string;
    environment: string;
    projectId: string;
    projectTitle: string;
    branch: string | null;
    worktreePath: string | null;
    createdAt: string;
  },
): string {
  if (!context) return `${THREAD_PREAMBLE}\n${message}`;
  const fields = {
    thread_id: context.threadId,
    saved_name: context.name,
    environment: context.environment,
    project_id: context.projectId,
    project_title: context.projectTitle,
    branch: context.branch,
    worktree_path: context.worktreePath,
    parent_thread_id: context.parent?.threadId ?? "none",
    parent_saved_name: context.parent?.name ?? "none",
    parent_title: context.parent?.title ?? "none",
    parent_environment: context.parent?.environment ?? "none",
    parent_send_command: context.parent ? threadSendCommand(context.parent) : "none",
    notify_level: context.notifyLevel,
    date_utc: context.createdAt.slice(0, 10),
  };
  const header = Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `${header}\n\n${THREAD_PREAMBLE}\n${message}`;
}
