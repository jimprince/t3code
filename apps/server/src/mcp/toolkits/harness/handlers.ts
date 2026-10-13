import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { HarnessPinService } from "../../../harness/HarnessPinService.ts";
import { HarnessReadService } from "../../../harness/HarnessReadService.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { HarnessToolkit } from "./tools.ts";

import { RoutineKindService } from "../../../harness/RoutineKindService.ts";

export const HarnessHandlersLive = McpToolAccess.toLayer(HarnessToolkit, {
  harness_routine_kind_set: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const caller = yield* readCaller();
      const service = yield* RoutineKindService;
      if (caller.scope.environmentId !== service.environmentId)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential belongs to another environment.",
        });
      return yield* service.set(input).pipe(Effect.mapError(unavailable));
    }),
  ),
  harness_snapshot: McpToolAccess.reads((input) =>
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
  ),
  harness_check_pin: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
      if (descriptor.environmentId !== caller.scope.environmentId)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential belongs to another environment.",
        });
      const pinnedCheckKeys = yield* (yield* HarnessPinService)
        .setPinned(input)
        .pipe(Effect.mapError(unavailable));
      return { pinnedCheckKeys };
    }),
  ),
});
