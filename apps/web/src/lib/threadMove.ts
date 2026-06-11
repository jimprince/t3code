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
