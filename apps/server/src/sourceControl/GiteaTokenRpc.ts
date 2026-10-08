import { WS_METHODS, type GiteaTokenSetInput } from "@t3tools/contracts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { ServerSettingsService } from "../serverSettings.ts";

/** Shared by the fork WebSocket handler and its transport tests. */
export const makeGiteaTokenRpcHandler =
  (settings: Pick<ServerSettingsService["Service"], "setGiteaToken">) =>
  (input: GiteaTokenSetInput) =>
    observeRpcEffect(WS_METHODS.giteaSetToken, settings.setGiteaToken(input), {
      "rpc.aggregate": "server",
    });
