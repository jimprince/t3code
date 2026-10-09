import { hostReceiptDigest } from "./HostReceipt.ts";
import {
  ThreadRecoveryError,
  HandoverRoutesInput,
  type HandoverHostReceipt,
} from "@t3tools/contracts";
import { updateState } from "@t3tools/shared/threadRoutingState";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RecoveryAuthority, requireAdmin } from "./RecoveryAuthority.ts";
import { transferHostRoutes } from "./HostRoutes.ts";

/** One locked, atomically written operation on this host; callers collect each host's receipt. */
export class HostRouteTransfer extends Context.Service<
  HostRouteTransfer,
  {
    readonly transfer: (
      input: typeof HandoverRoutesInput.Type,
    ) => Effect.Effect<HandoverHostReceipt, ThreadRecoveryError, RecoveryAuthority>;
  }
>()("t3/threadRecovery/HostRouteTransfer") {}
const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  return HostRouteTransfer.of({
    transfer: (raw) =>
      Effect.gen(function* () {
        const authority = yield* requireAdmin;
        const input = yield* Schema.decodeUnknownEffect(HandoverRoutesInput)(raw).pipe(
          Effect.mapError(
            () =>
              new ThreadRecoveryError({
                code: "conflict",
                message: "Invalid host transfer parameters.",
              }),
          ),
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        return yield* Effect.tryPromise({
          try: () =>
            updateState<Record<string, unknown>, HandoverHostReceipt>({}, (state) => {
              const moved = transferHostRoutes(
                state,
                input,
                authority.principal,
                environmentId,
                now,
              );
              if (!moved.key) return { state: moved.state, result: moved.receipt };
              const receipt = {
                ...moved.receipt,
                digest: hostReceiptDigest(moved.receipt),
              };
              return {
                state: {
                  ...moved.state,
                  handoverReceipts: [
                    ...moved.history,
                    { key: moved.key, fingerprint: moved.fingerprint, receipt },
                  ],
                },
                result: receipt,
              };
            }),
          catch: (cause) =>
            Schema.is(ThreadRecoveryError)(cause)
              ? cause
              : new ThreadRecoveryError({
                  code: "storage",
                  message:
                    "Host routes were not transferred; retry after inspecting the host state.",
                }),
        });
      }),
  });
});
export const layer = Layer.effect(HostRouteTransfer, make);
