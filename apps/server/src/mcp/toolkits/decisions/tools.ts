import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ProjectIssuesError,
  ProjectRequestDecideResult,
  ProjectRequestRef,
  ProjectRequestUpdateInput,
  ProjectRequestDiscussResult,
  ThreadId,
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

const failure = Schema.Union([
  McpCapabilityUnavailableError,
  ProjectIssuesError,
  OrchestratorMcpFailure,
]);

const decisionFields = {
  reference: TrimmedNonEmptyString.annotate({
    description: "The decision's issue: owner/repo#N, an issue URL, or N in the project tracker.",
  }),
  threadId: Schema.optionalKey(
    ThreadId.annotate({
      description:
        "A thread of the decision's project, when it is not this thread's project (the thread named in a discussion brief's answer command).",
    }),
  ),
};

const DiscussDecisionTool = Tool.make("decision_discuss", {
  description:
    "Open a thread to talk a decision through with Brad, nested under the thread waiting on it and seeded with the question, its options and how to record the answer. Reuses a live discussion of the same decision.",
  parameters: Schema.Struct(decisionFields),
  success: ProjectRequestDiscussResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Discuss a decision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AnswerDecisionTool = Tool.make("decision_answer", {
  description:
    "Record the answer Brad settled on, exactly as answering from the Decisions widget or Needs you: the answer is commented on the issue and sent to the waiting thread, and a needs-brad decision leaves the widget. Only record what Brad decided.",
  parameters: Schema.Struct({
    ...decisionFields,
    decision: Schema.Literals(["option", "answer", "approve", "reject", "not-yet"]).annotate({
      description:
        "option: the verbatim proposed choice; answer: Brad's own words on any open item; approve: close finished work, acknowledge an answer or confirm a test, but start a plan/epic; reject: send work back with note; not-yet: defer a plan. Only relay Brad's explicit decision. When producing a review, supply 2 to 5 ready options when there is a real choice, else defaults apply.",
    }),
    option: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
    answer: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
    note: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(500)).annotate({
        description: "One line of why, or the reason for not yet.",
      }),
    ),
  }),
  success: ProjectRequestDecideResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Answer a decision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ReadyRequestTool = Tool.make("request_ready", {
  description:
    "Mark work ready for Brad. Supply a plain sentence explaining what changed/proposed beyond the title, a 'What you are judging and where:' line with a screenshot/link/Dev Update location, 2 to 5 Option A:/Option B: choices (or options), and Recommended: Option A. A title-only summary is refused; missing location, recommendation or choices returns warnings. Finished work defaults to Approve and close / Reject; plans to Approve: go ahead / Not yet; tests to Passed / Failed. Only Brad settles.",
  parameters: Schema.Struct({
    ...decisionFields,
    summary: TrimmedNonEmptyString,
    stage: Schema.optionalKey(Schema.Literals(["needs-review", "needs-test"])),
    release: ProjectRequestUpdateInput.fields.release,
    options: ProjectRequestUpdateInput.fields.options,
  }),
  success: ProjectRequestRef,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Mark a request ready")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const DecisionsToolkit = Toolkit.make(
  DiscussDecisionTool,
  AnswerDecisionTool,
  ReadyRequestTool,
);
