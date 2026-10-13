import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError, requestGuarded } from "./client.ts";

/** @public Requires the permission guard installed by a client command. */
export const setHarnessCheckPinned = Effect.fn("setHarnessCheckPinned")(function* (
  environmentId: EnvironmentId,
  checkKey: string,
  pinned: boolean,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  return yield* registry
    .run(environmentId, requestGuarded(WS_METHODS.harnessCheckPinSet, { checkKey, pinned }))
    .pipe(
      Effect.map((result) => result.pinnedCheckKeys),
      Effect.catchTags({
        EnvironmentNotRegisteredError: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId,
              message: "This environment is unavailable.",
            }),
          ),
      }),
    );
});
