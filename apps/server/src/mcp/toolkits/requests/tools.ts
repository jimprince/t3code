import {
  ProjectRequestPlace,
  ProjectRequestQueueResult,
  ProjectRequestNextResult,
  ProjectRequestOrderResult,
  ProjectRequestCreateResult,
  UploadedAttachmentRef,
  PositiveInt,
  ProjectIssuesError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
const common = {
  failure: Schema.Union([
    ProjectIssuesError,
    McpCapabilityUnavailableError,
    OrchestratorMcpFailure,
  ]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const thread = { threadId: Schema.optionalKey(ThreadId) };
const queue = {
  ...thread,
  epic: Schema.optionalKey(PositiveInt),
  all: Schema.optionalKey(Schema.Boolean),
};
const order = Tool.make("request_order", {
  ...common,
  description:
    "Move a task within its workstream or an epic among workstreams. Do not reorder existing work unless Brad asked.",
  parameters: Schema.Struct({
    ...thread,
    reference: TrimmedNonEmptyString,
    place: ProjectRequestPlace,
  }),
  success: ProjectRequestOrderResult,
}).annotate(Tool.Readonly, false);
const readQueue = Tool.make("request_queue", {
  ...common,
  description:
    "Read the project's ordered workstreams, now and next items, and unplaced new items.",
  parameters: Schema.Struct(queue),
  success: ProjectRequestQueueResult,
}).annotate(Tool.Readonly, true);
const next = Tool.make("request_next", {
  ...common,
  description: "Pick the first queued, unblocked, unstarted task in workstream order.",
  parameters: Schema.Struct({ ...thread, epic: Schema.optionalKey(PositiveInt) }),
  success: ProjectRequestNextResult,
}).annotate(Tool.Readonly, true);
const add = Tool.make("request_add", {
  ...common,
  description:
    "File Brad's words as a task, bug, or epic: place it if you are sure of the workstream and position; leave it unplaced only when unsure. Use partOf for the epic and place={to:'top'|'bottom'|'after',reference?:'#N'} for next, last or after.",
  parameters: Schema.Struct({
    ...thread,
    title: Schema.String.check(Schema.isPattern(/\S/)),
    kind: Schema.Literals(["task", "bug", "epic", "question"]),
    bug: Schema.optionalKey(Schema.Boolean),
    detail: Schema.optionalKey(Schema.String),
    partOf: Schema.optionalKey(PositiveInt),
    place: Schema.optionalKey(ProjectRequestPlace),
    messageId: Schema.optionalKey(TrimmedNonEmptyString),
    attachments: Schema.optionalKey(Schema.Array(UploadedAttachmentRef)),
  }),
  success: ProjectRequestCreateResult,
}).annotate(Tool.Readonly, false);
export const RequestsToolkit = Toolkit.make(order, readQueue, next, add);
