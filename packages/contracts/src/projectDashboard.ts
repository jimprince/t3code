import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A project page's visible widgets, in order. Ids are open-ended strings so a
 * later concern can add a widget without a schema change; clients ignore ids
 * they do not know.
 */
export const ProjectDashboardWidgets = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
).check(Schema.isMaxLength(40));
export type ProjectDashboardWidgets = typeof ProjectDashboardWidgets.Type;

export const ProjectDashboard = Schema.Struct({
  rootThreadId: ThreadId,
  /** The orchestrator's T3 project, whose tracker repository the page uses. */
  rootProjectId: ProjectId,
  /** Null until someone customizes the page; clients then show their default order. */
  widgets: Schema.NullOr(ProjectDashboardWidgets),
  /** `owner/repo` (or an issue-host URL to the repository) naming the project's Gitea tracker. */
  tracker: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectDashboard = typeof ProjectDashboard.Type;

/** Any thread in the project; the server resolves its orchestrator. */
export const ProjectDashboardGetInput = Schema.Struct({ threadId: ThreadId });
export type ProjectDashboardGetInput = typeof ProjectDashboardGetInput.Type;

export const ProjectDashboardSetWidgetsInput = Schema.Struct({
  threadId: ThreadId,
  /** Null restores the default order. */
  widgets: Schema.NullOr(ProjectDashboardWidgets),
});
export type ProjectDashboardSetWidgetsInput = typeof ProjectDashboardSetWidgetsInput.Type;

export const ProjectDashboardSetTrackerInput = Schema.Struct({
  threadId: ThreadId,
  /** Null clears the override, so the project's git remote decides again. */
  tracker: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectDashboardSetTrackerInput = typeof ProjectDashboardSetTrackerInput.Type;

export class ProjectDashboardError extends Schema.TaggedError<ProjectDashboardError>()(
  "ProjectDashboardError",
  { message: Schema.String },
) {}
