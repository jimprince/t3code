/**
 * ThreadBrief - Brief me for orchestrator threads.
 *
 * Summarizes worker traffic since the user's last message with the configured
 * text generation model. The summary is returned to the caller only: it is not
 * persisted and never enters the orchestrator's own context.
 *
 * @module ThreadBrief
 */
import type {
  OrchestrationBriefThreadError,
  OrchestrationBriefThreadInput,
  OrchestrationBriefThreadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ThreadBriefShape {
  readonly briefThread: (
    input: OrchestrationBriefThreadInput,
  ) => Effect.Effect<OrchestrationBriefThreadResult, OrchestrationBriefThreadError>;
}

export class ThreadBrief extends Context.Service<ThreadBrief, ThreadBriefShape>()(
  "t3/orchestration/Services/ThreadBrief",
) {}
