import { ThreadIssueOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadIssueService from "../../../forkThreads/ThreadIssueService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadIssuesToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const management = yield* ThreadManagement.ThreadManagementService;
  const issues = yield* ThreadIssueService.make;

  const caller = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    if (scope.thread === undefined)
      return yield* new ThreadIssueOperationError({ message: "A calling T3 thread is required." });
    return scope.thread.threadId;
  });
  return {
    link_gitea_issue: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* caller;
        const result = yield* issues.link({ threadId, reference: input.reference });
        return { issue: result.link, changed: result.changed };
      }),
    ),
    unlink_gitea_issue: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* caller;
        const result = yield* issues.unlink({
          threadId,
          reference: input.reference,
        });
        return { changed: result.unlinked };
      }),
    ),
    list_thread_issues: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const threadId = yield* caller;
        const thread = yield* management
          .getThreadShell(threadId)
          .pipe(
            Effect.mapError(
              () => new ThreadIssueOperationError({ message: "Could not read thread issues." }),
            ),
          );
        if (thread === null) {
          return yield* new ThreadIssueOperationError({ message: "Thread was not found." });
        }
        return { issues: thread.issues ?? [] };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof ThreadIssuesToolkit.tools>;
});

export const ThreadIssuesToolkitHandlersLive = McpToolAccess.toLayer(ThreadIssuesToolkit, make);
