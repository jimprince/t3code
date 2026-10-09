import type {
  CommandId,
  OrchestrationV2DomainEvent,
  ThreadRecoveryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Resume CAS runs under the native dispatch lock; its receipt commits with the new run. */
export class ResumeAdmission extends Context.Reference<{
  readonly commandId: CommandId;
  readonly accept: Effect.Effect<boolean, ThreadRecoveryError>;
  readonly persist: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<void, ThreadRecoveryError>;
} | null>("t3/threadRecovery/ResumeAdmission", { defaultValue: () => null }) {}
