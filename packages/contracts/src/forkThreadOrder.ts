import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { ForkThreadMetadataError } from "./forkThreadMetadata.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
export const ForkThreadOrderReset = Schema.Struct({ commandId: CommandId, threadId: ThreadId });
export const ForkThreadOrderResetRpc = Rpc.make("fork.threads.order.reset", {
  payload: ForkThreadOrderReset,
  success: Schema.Void,
  error: Schema.Union([ForkThreadMetadataError, EnvironmentAuthorizationError]),
});
