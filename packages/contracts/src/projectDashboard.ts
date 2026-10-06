import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A project page's visible widgets, in order. Ids are open-ended strings so a
 * later concern can add a widget without a schema change; clients ignore ids
 * they do not know.
 */
export const ProjectDashboardWidgets = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
).check(Schema.isMaxLength(40));
export type ProjectDashboardWidgets = typeof ProjectDashboardWidgets.Type;

/** The project's health chip: answered first on the project page. */
export const ProjectHealthStatus = Schema.Literals([
  "on-track",
  "at-risk",
  "off-track",
  "waiting-on-you",
]);
export type ProjectHealthStatus = typeof ProjectHealthStatus.Type;

/** Written by the project's orchestrator; the dashboard curator checks it is fresh. */
export const ProjectHealth = Schema.Struct({
  status: ProjectHealthStatus,
  /** One sentence: where the project stands and why. */
  sentence: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  updatedAt: IsoDateTime,
  /** The thread that wrote it. */
  threadId: Schema.NullOr(ThreadId),
});
export type ProjectHealth = typeof ProjectHealth.Type;

export const ProjectDashboard = Schema.Struct({
  rootThreadId: ThreadId,
  /** The orchestrator's T3 project, whose tracker repository the page uses. */
  rootProjectId: ProjectId,
  /** Null until someone customizes the page; clients then show their default order. */
  widgets: Schema.NullOr(ProjectDashboardWidgets),
  /** `owner/repo` (or an issue-host URL to the repository) naming the project's Gitea tracker. */
  tracker: Schema.NullOr(TrimmedNonEmptyString),
  /** Null until the orchestrator writes one. Optional for older servers. */
  health: Schema.optionalKey(Schema.NullOr(ProjectHealth)),
});
export type ProjectDashboard = typeof ProjectDashboard.Type;

export const ProjectDashboardSetHealthInput = Schema.Struct({
  threadId: ThreadId,
  status: ProjectHealthStatus,
  sentence: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
});
export type ProjectDashboardSetHealthInput = typeof ProjectDashboardSetHealthInput.Type;

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
