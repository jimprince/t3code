import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { formatLocalIso } from "@t3tools/shared/localTime";

export type ThreadMovePhase = "exporting" | "importing" | "archiving";

export interface ThreadMoveTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface ThreadMoveResult {
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
  readonly warnings: ReadonlyArray<string>;
  readonly sourceArchived: boolean;
}

/**
 * Flatten an error plus its nested causes into diagnostic lines for the
 * failure toast. The toast's copy button copies the full description, so
 * everything needed to debug a failed move belongs here.
 */
export function collectErrorDiagnostics(error: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current === "string") {
      if (current.trim().length > 0) {
        lines.push(current.trim());
      }
      break;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) {
      break;
    }
    seen.add(current);
    const record = current as {
      _tag?: unknown;
      reason?: unknown;
      operation?: unknown;
      message?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    const segments: string[] = [];
    if (typeof record._tag === "string") {
      segments.push(record._tag);
    } else if (current instanceof Error && current.name !== "Error") {
      segments.push(current.name);
    }
    if (typeof record.reason === "string") {
      segments.push(`reason=${record.reason}`);
    }
    if (typeof record.operation === "string") {
      segments.push(record.operation);
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      segments.push(record.message.trim());
    }
    if (typeof record.detail === "string" && record.detail.trim().length > 0) {
      segments.push(record.detail.trim());
    }
    if (segments.length > 0) {
      const line = segments.join(": ");
      if (lines.at(-1) !== line) {
        lines.push(line);
      }
    }
    current = record.cause;
  }
  if (lines.length === 0) {
    lines.push("An unknown error occurred.");
  }
  return lines;
}

/**
 * Full diagnostic report for a failed move. The first line stays readable in
 * the toast; the rest rides along for the copy button and bug reports.
 */
export function buildThreadMoveFailureReport(input: {
  readonly error: unknown;
  readonly threadTitle: string;
  readonly source: ScopedThreadRef;
  readonly sourceLabel: string | null;
  readonly target: ThreadMoveTarget;
  readonly targetLabel: string | null;
  readonly phase: ThreadMovePhase | "preparing";
}): string {
  const [headline, ...causeLines] = collectErrorDiagnostics(input.error);
  return [
    headline,
    "",
    `Thread: "${input.threadTitle}" (${input.source.threadId})`,
    `From: ${input.sourceLabel ?? input.source.environmentId} (env ${input.source.environmentId})`,
    `To: ${input.targetLabel ?? input.target.environmentId} (env ${input.target.environmentId}, project ${input.target.projectId})`,
    `Failed while: ${input.phase}`,
    `At: ${formatLocalIso(Date.now())}`,
    ...(causeLines.length > 0 ? ["Error chain:", ...causeLines.map((line) => `  ${line}`)] : []),
  ].join("\n");
}

/** The import refused because the thread's branch already exists on the target with different history or is checked out there. */
export function isThreadMoveBranchConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    if ((current as { reason?: unknown }).reason === "branch-conflict") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs a move and, when the thread's branch already exists on the target,
 * offers one retry that lands the work on a fallback branch. The source copy
 * is archived by the move itself, only after the destination acknowledged a
 * durable import, so a failed move never loses the thread.
 */
export async function moveThreadWithBranchFallback(input: {
  readonly run: (branchConflict: "fail" | "new-worktree") => Promise<ThreadMoveResult>;
  readonly branch: string | null;
  readonly confirmBranchFallback: (branch: string) => Promise<boolean>;
}): Promise<ThreadMoveResult> {
  try {
    return await input.run("fail");
  } catch (error) {
    if (
      !isThreadMoveBranchConflict(error) ||
      input.branch === null ||
      !(await input.confirmBranchFallback(input.branch))
    ) {
      throw error;
    }
    return input.run("new-worktree");
  }
}

export function describeThreadMoveProgress(
  phase: ThreadMovePhase,
  targetLabel: string,
): { readonly title: string; readonly description: string } {
  return {
    title: "Moving thread…",
    description:
      phase === "exporting"
        ? "Exporting from the source machine"
        : phase === "importing"
          ? `Importing on ${targetLabel}`
          : "Archiving the source copy",
  };
}

export function describeThreadMoveOutcome(input: {
  readonly threadTitle: string;
  readonly targetLabel: string;
  readonly result: ThreadMoveResult;
}): {
  readonly type: "success" | "warning";
  readonly description: string;
  readonly timeout: number;
} {
  const notes = [
    ...input.result.warnings,
    ...(input.result.sourceArchived
      ? []
      : ["The source copy could not be archived; archive it manually."]),
  ];
  return notes.length > 0
    ? { type: "warning", description: notes.join("\n"), timeout: 0 }
    : {
        type: "success",
        description: `"${input.threadTitle}" now runs on ${input.targetLabel}.`,
        timeout: 8000,
      };
}
