import { ProjectIssuesError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadIssueService from "../../../forkThreads/ThreadIssueService.ts";

import * as ProjectIssuesService from "../../../projectIssues/ProjectIssuesService.ts";
import * as RequestLedger from "../../../projectIssues/RequestLedger.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DecisionsToolkit } from "./tools.ts";

/** Agents discuss and answer decisions through the same ledger methods as the clients' RPCs. */
const make = Effect.gen(function* () {
  const ledger = yield* RequestLedger.make({
    projectIssues: yield* ProjectIssuesService.make,
    threadIssues: yield* ThreadIssueService.make,
  });

  return {
    decision_discuss: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
          if (!input.threadId && scope.thread === undefined)
            return yield* new ProjectIssuesError({ message: "A calling T3 thread is required." });
          return yield* ledger.discuss({
            threadId: input.threadId ?? scope.thread!.threadId,
            reference: input.reference,
          });
        }),
    ),
    decision_answer: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
          if (!input.threadId && scope.thread === undefined)
            return yield* new ProjectIssuesError({ message: "A calling T3 thread is required." });
          return yield* ledger.decide({
            threadId: input.threadId ?? scope.thread!.threadId,
            reference: input.reference,
            decision: input.decision,
            ...(input.option === undefined ? {} : { option: input.option }),
            ...(input.answer === undefined ? {} : { answer: input.answer }),
            ...(input.note === undefined ? {} : { reason: input.note }),
          });
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof DecisionsToolkit.tools>;
});

export const DecisionsToolkitHandlersLive = McpToolAccess.toLayer(DecisionsToolkit, make);
