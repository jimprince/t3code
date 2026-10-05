import * as Schema from "effect/Schema";
import { IsoDateTime, type PullRequestActor, type PullRequestCheck } from "@t3tools/contracts";
import type { ProviderChangeRequest } from "./PullRequestProvider.ts";

const nullableText = Schema.optional(Schema.NullOr(Schema.String));
export const User = Schema.Struct({
  login: Schema.NonEmptyString,
  full_name: nullableText,
  avatar_url: nullableText,
});
const Ref = Schema.Struct({
  ref: Schema.String,
  label: nullableText,
  sha: Schema.String,
  repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
});
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  body: nullableText,
  user: Schema.NullOr(User),
  head: Ref,
  base: Ref,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  closed_at: Schema.optional(Schema.NullOr(IsoDateTime)),
  merged_at: Schema.optional(Schema.NullOr(IsoDateTime)),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  changed_files: Schema.optional(Schema.Number),
  comments: Schema.optional(Schema.Number),
  requested_reviewers: Schema.optional(Schema.NullOr(Schema.Array(User))),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, color: nullableText })),
    ),
  ),
});
export const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  user: Schema.NullOr(User),
  created_at: IsoDateTime,
  html_url: nullableText,
});
export const Review = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  user: Schema.NullOr(User),
  submitted_at: IsoDateTime,
  html_url: nullableText,
  state: Schema.String,
  dismissed: Schema.optional(Schema.Boolean),
  comments_count: Schema.optional(Schema.Number),
});
export const ReviewComment = Schema.Struct({ ...Comment.fields, path: Schema.String });
export const Commit = Schema.Struct({
  sha: Schema.NonEmptyString,
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.Struct({ date: IsoDateTime }),
  }),
});
export const CombinedStatus = Schema.Struct({
  total_count: Schema.Number,
  state: Schema.String,
  statuses: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        context: Schema.String,
        status: Schema.String,
        description: nullableText,
        target_url: nullableText,
      }),
    ),
  ),
});
export const actor = (user: typeof User.Type | null): PullRequestActor | null =>
  user === null
    ? null
    : {
        login: user.login,
        name: user.full_name || null,
        avatarUrl: user.avatar_url || null,
      };
export const toChangeRequest = (pr: typeof PullRequest.Type): ProviderChangeRequest => ({
  number: pr.number,
  title: pr.title,
  url: pr.html_url,
  author: actor(pr.user),
  headBranch:
    pr.state === "closed" && pr.head.ref === `refs/pull/${pr.number}/head` && pr.head.label
      ? pr.head.label
      : pr.head.ref,
  headRepositoryNameWithOwner: pr.head.repo?.full_name ?? null,
  baseBranch: pr.base.ref,
  state: pr.merged ? "merged" : pr.state,
  isDraft: pr.draft ?? /^(?:\[WIP\]|WIP:|\[DRAFT\]|DRAFT:)/i.test(pr.title),
  mergeability:
    pr.mergeable === true ? "mergeable" : pr.mergeable === false ? "conflicting" : "unknown",
  additions: pr.additions ?? 0,
  deletions: pr.deletions ?? 0,
  createdAt: pr.created_at,
  updatedAt: pr.updated_at,
  closedAt: pr.closed_at ?? null,
  mergedAt: pr.merged_at ?? null,
  reviewRequestLogins: (pr.requested_reviewers ?? []).map((u) => u.login),
  labels: (pr.labels ?? []).map((l) => ({ name: l.name, color: l.color || null })),
});
export const toCheck = (
  status: NonNullable<typeof CombinedStatus.Type.statuses>[number],
): PullRequestCheck => ({
  name: status.context || "CI",
  description: status.description || null,
  url: status.target_url || null,
  status:
    status.status === "success"
      ? "success"
      : status.status === "failure" || status.status === "error"
        ? "failure"
        : status.status === "skipped"
          ? "skipped"
          : status.status === "warning"
            ? "action-required"
            : "pending",
});
