import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadIssueState = Schema.Literals(["open", "closed"]);
export type ThreadIssueState = typeof ThreadIssueState.Type;

/** Identity of a Gitea issue across projects and environments. */
export const ThreadIssueKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadIssueKey = typeof ThreadIssueKey.Type;

export const ThreadIssueSnapshot = Schema.Struct({
  title: TrimmedNonEmptyString,
  state: ThreadIssueState,
  syncedAt: IsoDateTime,
});
export type ThreadIssueSnapshot = typeof ThreadIssueSnapshot.Type;

export const ThreadIssueLink = Schema.Struct({
  ...ThreadIssueKey.fields,
  url: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  snapshot: ThreadIssueSnapshot,
});
export type ThreadIssueLink = typeof ThreadIssueLink.Type;

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
