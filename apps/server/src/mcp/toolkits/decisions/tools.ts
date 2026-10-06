import {
  McpCapabilityUnavailableError,
  ProjectIssuesError,
  ProjectRequestDecideResult,
  ProjectRequestDiscussResult,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const failure = Schema.Union([McpCapabilityUnavailableError, ProjectIssuesError]);

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
    decision: Schema.Literals(["option", "answer", "approve", "not-yet"]).annotate({
      description:
        "option: one of the listed options; answer: his own words (needs-brad decisions); approve or not-yet: a Needs you plan or item.",
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

export const DecisionsToolkit = Toolkit.make(DiscussDecisionTool, AnswerDecisionTool);
