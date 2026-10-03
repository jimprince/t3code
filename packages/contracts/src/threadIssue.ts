import * as Schema from "effect/Schema";

import { ThreadIssueLink, ThreadIssueKey } from "./orchestration.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadIssueReferenceInput = Schema.Struct({
  threadId: ThreadId,
  reference: TrimmedNonEmptyString,
});
export type ThreadIssueReferenceInput = typeof ThreadIssueReferenceInput.Type;

export const ThreadIssueLinkResult = Schema.Struct({
  link: ThreadIssueLink,
  changed: Schema.Boolean,
});
export type ThreadIssueLinkResult = typeof ThreadIssueLinkResult.Type;

export const ThreadIssueUnlinkResult = Schema.Struct({
  unlinked: Schema.Boolean,
  issue: ThreadIssueKey,
});
export type ThreadIssueUnlinkResult = typeof ThreadIssueUnlinkResult.Type;

export class ThreadIssueOperationError extends Schema.TaggedError<ThreadIssueOperationError>()(
  "ThreadIssueOperationError",
  { message: Schema.String },
) {}
