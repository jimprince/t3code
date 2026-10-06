import * as Effect from "effect/Effect";

import * as ThreadIssueService from "../../../orchestration/ThreadIssueService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectIssuesService from "../../../projectIssues/ProjectIssuesService.ts";
import * as RequestLedger from "../../../projectIssues/RequestLedger.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DecisionsToolkit } from "./tools.ts";

/** Agents discuss and answer decisions through the same ledger methods as the clients' RPCs. */
const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const ledger = yield* RequestLedger.make({
    projectIssues: yield* ProjectIssuesService.make,
    threadIssues: yield* ThreadIssueService.make,
    dispatch: engine.dispatch,
  });

  return DecisionsToolkit.of({
    decision_discuss: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        return yield* ledger.discuss({
          threadId: input.threadId ?? scope.threadId,
          reference: input.reference,
        });
      }),
    decision_answer: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        return yield* ledger.decide({
          threadId: input.threadId ?? scope.threadId,
          reference: input.reference,
          decision: input.decision,
          ...(input.option === undefined ? {} : { option: input.option }),
          ...(input.answer === undefined ? {} : { answer: input.answer }),
          ...(input.note === undefined ? {} : { reason: input.note }),
        });
      }),
  });
});

export const DecisionsToolkitHandlersLive = DecisionsToolkit.toLayer(make);
