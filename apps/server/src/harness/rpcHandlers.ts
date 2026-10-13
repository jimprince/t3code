import { HarnessCheckPinSetRpc, RpcScopeAuthorization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as HarnessPin from "./HarnessPinService.ts";

export const group = RpcGroup.make(HarnessCheckPinSetRpc).middleware(RpcScopeAuthorization);
/** Shared with the main WS group, so RPC tests exercise the production handler. */
export const handlers = group.of({
  "harness.checkPin.set": (input) =>
    Effect.flatMap(HarnessPin.HarnessPinService, (service) => service.setPinned(input)).pipe(
      Effect.map((pinnedCheckKeys) => ({ pinnedCheckKeys })),
    ),
});
