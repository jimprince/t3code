import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ServerHeadlessUpdateCheckInput, ServerHeadlessUpdateCheckResult } from "./server.ts";

export const HEADLESS_DELIVERY_METHODS = {
  serverRequestHeadlessUpdateCheck: "server.requestHeadlessUpdateCheck",
} as const;

export const HeadlessDeliveryRpc = Rpc.make(
  HEADLESS_DELIVERY_METHODS.serverRequestHeadlessUpdateCheck,
  {
    payload: ServerHeadlessUpdateCheckInput,
    success: ServerHeadlessUpdateCheckResult,
    error: EnvironmentAuthorizationError,
  },
);
