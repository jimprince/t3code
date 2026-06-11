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
 * Move a thread between environments: export the portable bundle from the
 * source server and import it into a project on the target server. The client
 * is the only party connected to both machines, so it carries the bundle.
 *
 * Archiving the source thread is intentionally left to the caller — it must
 * only happen after this resolves, so a failed move never loses the thread.
 */
export async function moveThreadToEnvironment(input: {
  readonly source: ScopedThreadRef;
  readonly target: ThreadMoveTarget;
  readonly onProgress?: (phase: ThreadMovePhase) => void;
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
  const imported = await targetApi.orchestration.importThread({
    projectId: input.target.projectId,
    bundle: exported.bundle,
  });

  return {
    threadId: imported.threadId,
    worktreePath: imported.worktreePath,
    warnings: imported.warnings,
  };
}
