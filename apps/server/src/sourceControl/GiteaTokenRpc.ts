import { type GiteaTokenSetInput } from "@t3tools/contracts";
import type { ServerSettingsService } from "../serverSettings.ts";

/** Shared by the fork WebSocket handler and its transport tests. */
export const makeGiteaTokenRpcHandler =
  (settings: Pick<ServerSettingsService["Service"], "setGiteaToken">) =>
  (input: GiteaTokenSetInput) =>
    settings.setGiteaToken(input);
