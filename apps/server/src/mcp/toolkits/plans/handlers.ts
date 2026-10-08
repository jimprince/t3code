import { ProjectIssuesError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Tool from "effect/ai/Tool";
import * as ThreadIssueService from "../../../forkThreads/ThreadIssueService.ts";
import * as ProjectIssuesService from "../../../projectIssues/ProjectIssuesService.ts";
import * as RequestLedger from "../../../projectIssues/RequestLedger.ts";
import * as PlanPublicationService from "../../../projectIssues/PlanPublicationService.ts";
import * as PlanTaskLaunch from "../../../projectIssues/PlanTaskLaunch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readCaller, assertFullAccess } from "../../threadAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PlansToolkit } from "./tools.ts";

export const makeHandlers = (
  publisher: Effect.Success<ReturnType<typeof PlanPublicationService.make>>,
) => {
  return {
    t3_plan_publish: (input: Tool.Parameters<typeof PlansToolkit.tools.t3_plan_publish>) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        const threadId = input.threadId ?? scope.thread?.threadId;
        if (!threadId)
          return yield* new ProjectIssuesError({ message: "A calling T3 thread is required." });
        if (input.createThreads)
          yield* readCaller()
            .pipe(
              Effect.flatMap((caller) =>
                assertFullAccess(
                  caller,
                  "Starting task workers requires a full-access/default caller.",
                ),
              ),
            )
            .pipe(Effect.mapError((error) => new ProjectIssuesError({ message: error.message })));
        return yield* publisher.publish({ ...input, threadId });
      }),
  };
};

const make = Effect.gen(function* () {
  const ledger = yield* RequestLedger.make({
    projectIssues: yield* ProjectIssuesService.make,
    threadIssues: yield* ThreadIssueService.make,
  });
  const publisher = yield* PlanPublicationService.make(
    ledger,
    yield* PlanTaskLaunch.make.pipe(Effect.orDie),
  );
  const handlers = makeHandlers(publisher);
  return {
    t3_plan_publish: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      handlers.t3_plan_publish,
    ),
  } satisfies McpToolAccess.Handlers<typeof PlansToolkit.tools>;
});
export const PlansToolkitHandlersLive = McpToolAccess.toLayer(PlansToolkit, make);
