import type { CommandId, OrchestrationV2ServerCommand, HandoffError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type * as Effect from "effect/Effect";

/** Fork admission runs inside the native ownership and per-thread lifecycle locks. */
export interface Admission {
  commandId: CommandId;
  accept: Effect.Effect<boolean, HandoffError>;
  persist: Effect.Effect<void, HandoffError>;
  finish: (
    dispatchLocked: (
      command: OrchestrationV2ServerCommand,
    ) => ReturnType<OrchestratorV2["Service"]["dispatch"]>,
  ) => Effect.Effect<void, HandoffError>;
}
export class MessageAdmission extends Context.Reference<Admission | null>("fork/MessageAdmission", {
  defaultValue: () => null,
}) {}
