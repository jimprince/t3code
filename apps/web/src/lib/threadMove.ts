import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";

export type ThreadMovePhase = "exporting" | "importing";

export interface ThreadMoveTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface ThreadMoveResult {
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
  readonly warnings: readonly string[];
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
    `At: ${new Date().toISOString()}`,
    ...(causeLines.length > 0 ? ["Error chain:", ...causeLines.map((line) => `  ${line}`)] : []),
  ].join("\n");
}

/** The import refused because the thread's branch already exists on the
 * target with different history or is checked out there. */
export function isThreadMoveBranchConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { reason?: unknown }).reason === "branch-conflict"
  );
}

/**
 * Move a thread between environments: export the portable bundle from the
 * source server and import it into a project on the target server. The client
 * is the only party connected to both machines, so it carries the bundle.
 *
 * When the thread's branch already exists on the target (e.g. a thread
 * working directly on `main`), the import fails with a branch-conflict
 * reason; if `confirmBranchFallback` is provided and resolves true, the
 * import is retried with the new-worktree option, landing the work on a
 * fallback branch at the exported tip without touching the target's branch.
 *
 * Archiving the source thread is intentionally left to the caller — it must
 * only happen after this resolves, so a failed move never loses the thread.
 */
export async function moveThreadToEnvironment(input: {
  readonly source: ScopedThreadRef;
  readonly target: ThreadMoveTarget;
  readonly onProgress?: (phase: ThreadMovePhase) => void;
  readonly confirmBranchFallback?: (branch: string) => Promise<boolean>;
}): Promise<ThreadMoveResult> {
  const sourceApi = readEnvironmentApi(input.source.environmentId);
  if (!sourceApi) {
    throw new Error("The source machine is not connected.");
  }
  const targetApi = readEnvironmentApi(input.target.environmentId);
  if (!targetApi) {
    throw new Error("The target machine is not connected.");
  }

  input.onProgress?.("exporting");
  const exported = await sourceApi.orchestration.exportThread({
    threadId: input.source.threadId,
  });

  input.onProgress?.("importing");
  let imported;
  try {
    imported = await targetApi.orchestration.importThread({
      projectId: input.target.projectId,
      bundle: exported.bundle,
    });
  } catch (error) {
    const branch = exported.bundle.git?.branch;
    if (
      !isThreadMoveBranchConflict(error) ||
      branch === undefined ||
      !input.confirmBranchFallback ||
      !(await input.confirmBranchFallback(branch))
    ) {
      throw error;
    }
    imported = await targetApi.orchestration.importThread({
      projectId: input.target.projectId,
      bundle: exported.bundle,
      branchConflict: "new-worktree",
    });
  }

  return {
    threadId: imported.threadId,
    worktreePath: imported.worktreePath,
    warnings: imported.warnings,
  };
}
