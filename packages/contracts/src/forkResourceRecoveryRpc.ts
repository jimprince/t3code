import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ServerRecoveryExecuteInput,
  ServerRecoveryExecuteResult,
  ServerRecoveryPreviewResult,
} from "./server.ts";
export const RESOURCE_RECOVERY_METHODS = {
  serverPreviewRecovery: "server.previewRecovery",
  serverExecuteRecovery: "server.executeRecovery",
} as const;
export const ResourceRecoveryPreviewRpc = Rpc.make(
  RESOURCE_RECOVERY_METHODS.serverPreviewRecovery,
  {
    payload: Schema.Struct({}),
    success: ServerRecoveryPreviewResult,
    error: EnvironmentAuthorizationError,
  },
);
export const ResourceRecoveryExecuteRpc = Rpc.make(
  RESOURCE_RECOVERY_METHODS.serverExecuteRecovery,
  {
    payload: ServerRecoveryExecuteInput,
    success: ServerRecoveryExecuteResult,
    error: EnvironmentAuthorizationError,
  },
);
