import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectEpicProgress, ProjectRequestStage } from "./projectIssues.ts";

/** A version on the roadmap: an open Gitea milestone on the project's tracker repository. */
export const ProjectRoadmapVersion = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
  dueOn: Schema.NullOr(Schema.String),
  openIssues: NonNegativeInt,
  /** Closed issues in the version: its complete tasks, for the progress line. */
  closedIssues: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** The milestone's description: the release's outcome, when it has one. */
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ProjectRoadmapVersion = typeof ProjectRoadmapVersion.Type;

/**
 * An open request or issue on the tracker: in a version, or unversioned when
 * `versionId` is null. Unversioned work belongs to the next version unless it
 * is parked (saved for later), which keeps it off the Dashboard.
 */
export const ProjectRoadmapItem = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  isRequest: Schema.Boolean,
  stage: Schema.NullOr(ProjectRequestStage),
  versionId: Schema.NullOr(PositiveInt),
  parked: Schema.Boolean,
  /** Set for epics. */
  epic: Schema.optionalKey(ProjectEpicProgress),
});
export type ProjectRoadmapItem = typeof ProjectRoadmapItem.Type;

export const ProjectRoadmap = Schema.Struct({
  /** The tracker repository whose milestones are the versions; null when the project has none. */
  tracker: Schema.NullOr(
    Schema.Struct({ host: TrimmedNonEmptyString, repository: TrimmedNonEmptyString }),
  ),
  /** Open versions in roadmap order (due date, then creation); the first is the next release. */
  versions: Schema.Array(ProjectRoadmapVersion),
  items: Schema.Array(ProjectRoadmapItem),
});
export type ProjectRoadmap = typeof ProjectRoadmap.Type;

export const ProjectRoadmapGetInput = Schema.Struct({ threadId: ThreadId });
export type ProjectRoadmapGetInput = typeof ProjectRoadmapGetInput.Type;

/**
 * Moves a request or issue into a version (by title); with `null`, out of every
 * version into the automatic next version; with `later`, into Later (parked).
 */
export const ProjectRoadmapMoveInput = Schema.Struct({
  threadId: ThreadId,
  /** Issue number in the tracker repository, owner/repo#N, or the issue URL. */
  reference: TrimmedNonEmptyString,
  version: Schema.NullOr(TrimmedNonEmptyString),
  later: Schema.optionalKey(Schema.Boolean),
});
export type ProjectRoadmapMoveInput = typeof ProjectRoadmapMoveInput.Type;

/** Adds a version, or renames one when `id` is given. */
export const ProjectRoadmapSaveVersionInput = Schema.Struct({
  threadId: ThreadId,
  id: Schema.optionalKey(PositiveInt),
  title: TrimmedNonEmptyString,
});
export type ProjectRoadmapSaveVersionInput = typeof ProjectRoadmapSaveVersionInput.Type;

export class ProjectRoadmapError extends Schema.TaggedError<ProjectRoadmapError>()(
  "ProjectRoadmapError",
  { message: Schema.String },
) {}
