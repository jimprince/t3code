/**
 * ThreadTransfer - Cross-environment thread move service interface.
 *
 * `exportThread` quiesces a thread and packages its portable state (history,
 * git branch + checkpoints + uncommitted changes, provider session transcript)
 * into a versioned `ThreadMoveBundle`. `importThread` reconstructs that thread
 * under a project on this environment. The client orchestrates a move by
 * calling export on the source server and import on the target server.
 *
 * @module ThreadTransfer
 */
import type {
  OrchestrationExportThreadError,
  OrchestrationExportThreadInput,
  OrchestrationExportThreadResult,
  OrchestrationForkThreadError,
  OrchestrationForkThreadInput,
  OrchestrationForkThreadResult,
  OrchestrationImportThreadError,
  OrchestrationImportThreadInput,
  OrchestrationImportThreadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ThreadTransferShape {
  /**
   * Interrupt/stop the thread's provider session, then package the thread
   * into a portable move bundle. Does not archive or delete the source
   * thread; the caller archives it after a confirmed import.
   */
  readonly exportThread: (
    input: OrchestrationExportThreadInput,
  ) => Effect.Effect<OrchestrationExportThreadResult, OrchestrationExportThreadError>;

  /**
   * Reconstruct a thread from a move bundle under the target project:
   * restore git state (branch, checkpoint refs, worktree, dirty changes),
   * transplant the provider session transcript, and replay the portable
   * thread into the orchestration event log.
   */
  readonly importThread: (
    input: OrchestrationImportThreadInput,
  ) => Effect.Effect<OrchestrationImportThreadResult, OrchestrationImportThreadError>;

  /**
   * Clone a thread's visible history and provider context at a selected
   * message boundary. The source thread is never mutated.
   */
  readonly forkThread: (
    input: OrchestrationForkThreadInput,
  ) => Effect.Effect<OrchestrationForkThreadResult, OrchestrationForkThreadError>;
}

export class ThreadTransfer extends Context.Service<ThreadTransfer, ThreadTransferShape>()(
  "t3/orchestration/Services/ThreadTransfer",
) {}
