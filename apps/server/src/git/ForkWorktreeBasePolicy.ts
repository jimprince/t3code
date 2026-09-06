import { GitCommandError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as GitWorkflow from "./GitWorkflowService.ts";
import type * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
/** Native launch owns all preparation and rollback. This policy only selects and refreshes the exact base commit. */
export const resolveForkWorktreeBase = Effect.fn("ForkWorktreeBasePolicy.resolve")(function* (
  git: Pick<
    GitWorkflow.GitWorkflowService["Service"],
    "resolveRemoteWorktreeBase" | "fetchRemote" | "resolveRemoteTrackingCommit"
  >,
  tracker: Pick<WorktreeSetupTracker.WorktreeSetupTracker["Service"], "stageStatus">,
  input: {
    readonly cwd: string;
    readonly baseRef: string;
    readonly startFromOrigin?: boolean | undefined;
    readonly threadId: ThreadId;
  },
) {
  if (input.startFromOrigin !== true) {
    yield* tracker.stageStatus(input.threadId, "fetch", "skipped");
    return input.baseRef;
  }
  yield* tracker.stageStatus(input.threadId, "fetch", "running");
  const selected = yield* git.resolveRemoteWorktreeBase({
    cwd: input.cwd,
    baseBranch: input.baseRef,
  });
  if (!selected)
    return yield* new GitCommandError({
      operation: "ForkWorktreeBasePolicy.resolve",
      cwd: input.cwd,
      command: "git fetch",
      detail: `Cannot resolve a remote base for '${input.baseRef}'. Select a configured remote branch or disable Use remote base branch.`,
    });
  yield* git.fetchRemote({
    cwd: input.cwd,
    remoteName: selected.remoteName,
    refName: selected.refName,
  });
  const resolved = yield* git.resolveRemoteTrackingCommit({
    cwd: input.cwd,
    refName: selected.refName,
    fallbackRemoteName: selected.remoteName,
  });
  yield* tracker.stageStatus(input.threadId, "fetch", "done");
  return resolved.commitSha;
});
