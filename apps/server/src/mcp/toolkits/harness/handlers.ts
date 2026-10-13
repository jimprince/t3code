import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HarnessReadService } from "../../../harness/HarnessReadService.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { HarnessToolkit } from "./tools.ts";

export const HarnessHandlersLive = HarnessToolkit.toLayer({
  harness_snapshot: (input) =>
    Effect.gen(function* () {
      const caller = yield* readCaller();
      const snapshot = yield* (yield* HarnessReadService)
        .snapshot(input)
        .pipe(Effect.mapError(unavailable));
      if (snapshot.environmentId !== caller.scope.environmentId)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential belongs to another environment.",
        });
      return snapshot;
    }),
});
