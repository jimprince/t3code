import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  McpCapabilityUnavailableError,
  ProjectIssuesError,
  PlanPublicationInput,
  PlanPublicationResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const PlansToolkit = Toolkit.make(
  Tool.make("t3_plan_publish", {
    description:
      "Publish a plan already approved by Brad as a workstream epic and owned task issues in the project's Gitea tracker. Choose a stored proposed_plan or a markdown task list with a stable key. Reruns update the same issues and preserve completion/manual notes. Optional createThreads starts one nested issue-linked worker per task; reruns recover the same workers. Each top-level list item is a task; indented Owner: overrides the default. Use trailing <!-- task:stable-key --> markers if you will reorder tasks.",
    parameters: Schema.Struct({
      ...PlanPublicationInput.fields,
      threadId: Schema.optionalKey(ThreadId),
    }),
    success: PlanPublicationResult,
    failure: Schema.Union([McpCapabilityUnavailableError, ProjectIssuesError]),
    dependencies: [McpInvocationContext.McpInvocationContext, ThreadManagementService],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true),
);
