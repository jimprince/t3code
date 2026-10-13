import { HarnessSetCheckPinnedRpc, RpcScopeAuthorization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as HarnessPin from "./HarnessPinService.ts";

export const group = RpcGroup.make(HarnessSetCheckPinnedRpc).middleware(RpcScopeAuthorization);
/** Spread into the main WS handlers, so RPC tests exercise the production handler. */
export const handlers = group.of({
  "harness.setCheckPinned": (input) =>
    Effect.flatMap(HarnessPin.HarnessPinService, (service) => service.setPinned(input)).pipe(
      Effect.map((pinnedCheckKeys) => ({ pinnedCheckKeys })),
    ),
});
