import * as Schema from "effect/Schema";
import { ThreadId, PlanId } from "./baseSchemas.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Publishing is an explicit act on an approved plan, not approval itself. */
export const PlanPublicationInput = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  owner: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  createThreads: Schema.optional(Schema.Boolean),
  source: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("markdown"),
      key: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
      markdown: TrimmedNonEmptyString.check(Schema.isMaxLength(120000)),
    }),
    Schema.Struct({
      type: Schema.Literal("proposed_plan"),
      threadId: ThreadId,
      planId: PlanId,
    }),
  ]),
});
export type PlanPublicationInput = typeof PlanPublicationInput.Type;

export const PublishedPlanIssue = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  url: TrimmedNonEmptyString,
});
export const PlanPublicationResult = Schema.Struct({
  epic: PublishedPlanIssue,
  tasks: Schema.Array(
    Schema.Struct({
      ...PublishedPlanIssue.fields,
      key: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      owner: TrimmedNonEmptyString,
      threadId: Schema.optional(ThreadId),
    }),
  ),
});
export type PlanPublicationResult = typeof PlanPublicationResult.Type;
