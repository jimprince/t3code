import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadIssueLink,
  ThreadIssueOperationError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
];

const ThreadIssueReferenceInput = Schema.Struct({
  reference: TrimmedNonEmptyString.annotate({
    description:
      "A configured Gitea owner/repo#N reference or canonical issue URL, including a public alias of the configured instance.",
  }),
});

const failure = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadIssueOperationError,
  OrchestratorMcpFailure,
]);

const LinkGiteaIssueTool = Tool.make("link_gitea_issue", {
  description:
    "Link a configured Gitea issue to this thread so every T3 client shows its title and state. Use this when the thread is working on a specific bug or feature.",
  parameters: ThreadIssueReferenceInput,
  success: Schema.Struct({ issue: ThreadIssueLink, changed: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Link Gitea issue to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkGiteaIssueTool = Tool.make("unlink_gitea_issue", {
  description: "Remove a stale or mistaken Gitea issue link from this thread.",
  parameters: ThreadIssueReferenceInput,
  success: Schema.Struct({ changed: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Unlink Gitea issue from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadIssuesTool = Tool.make("list_thread_issues", {
  description: "List the Gitea issues linked to this thread with their cached title and state.",
  success: Schema.Struct({ issues: Schema.Array(ThreadIssueLink) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List thread Gitea issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadIssuesToolkit = Toolkit.make(
  LinkGiteaIssueTool,
  UnlinkGiteaIssueTool,
  ListThreadIssuesTool,
);
