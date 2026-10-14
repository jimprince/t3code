import { ProjectIssuesError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadIssues from "../../../forkThreads/ThreadIssueService.ts";
import * as ProjectIssues from "../../../projectIssues/ProjectIssuesService.ts";
import * as RequestLedger from "../../../projectIssues/RequestLedger.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { RequestsToolkit } from "./tools.ts";
const callingContext = (threadId?: ThreadId) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const id = threadId ?? scope.thread?.threadId;
    if (!id) return yield* new ProjectIssuesError({ message: "A calling T3 thread is required." });
    return { threadId: id, actorThreadId: scope.thread?.threadId ?? id };
  });
const make = Effect.gen(function* () {
  const ledger = yield* RequestLedger.make({
    projectIssues: yield* ProjectIssues.make,
    threadIssues: yield* ThreadIssues.make,
  });
  return {
    request_order: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        callingContext(input.threadId).pipe(
          Effect.flatMap((context) => ledger.order({ ...input, ...context })),
        ),
    ),
    request_queue: McpToolAccess.reads((input) =>
      callingContext(input.threadId).pipe(
        Effect.flatMap((context) => ledger.queue({ ...input, threadId: context.threadId })),
      ),
    ),
    request_next: McpToolAccess.reads((input) =>
      callingContext(input.threadId).pipe(
        Effect.flatMap((context) => ledger.next({ ...input, threadId: context.threadId })),
      ),
    ),
    request_add: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        callingContext(input.threadId).pipe(
          Effect.flatMap((context) =>
            ledger.create({
              ...input,
              ...context,
              title: input.title.trim(),
              detail: input.detail ?? input.title,
              kind: input.kind === "bug" ? "task" : input.kind,
              ...(input.kind === "bug" ? { bug: true } : {}),
            }),
          ),
        ),
    ),
  } satisfies McpToolAccess.Handlers<typeof RequestsToolkit.tools>;
});
export const RequestsToolkitHandlersLive = McpToolAccess.toLayer(RequestsToolkit, make);
