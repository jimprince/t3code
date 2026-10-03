import { ThreadIssueOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadIssueService from "../../../orchestration/ThreadIssueService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadIssuesToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const issues = yield* ThreadIssueService.make;

  return ThreadIssuesToolkit.of({
    link_gitea_issue: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        const result = yield* issues.link({ threadId: scope.threadId, reference: input.reference });
        return { issue: result.link, changed: result.changed };
      }),
    unlink_gitea_issue: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        const result = yield* issues.unlink({
          threadId: scope.threadId,
          reference: input.reference,
        });
        return { changed: result.unlinked };
      }),
    list_thread_issues: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        const thread = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(
            Effect.mapError(
              () => new ThreadIssueOperationError({ message: "Could not read thread issues." }),
            ),
          );
        if (Option.isNone(thread)) {
          return yield* new ThreadIssueOperationError({ message: "Thread was not found." });
        }
        return { issues: thread.value.issues ?? [] };
      }),
  });
});

export const ThreadIssuesToolkitHandlersLive = ThreadIssuesToolkit.toLayer(make);
