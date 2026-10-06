import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectAutomationSchedule } from "./projectAutomations.ts";

/**
 * Scripts and automation rules. A script is a named prompt procedure scoped to a project or
 * global; an automation is an on/off rule `triggers -> actions` whose firings are recorded as
 * runs. These records live in their own tables, outside the orchestration read model.
 */

const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Prompt = TrimmedNonEmptyString.check(Schema.isMaxLength(100_000));
const Time = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
const TimeZone = ProjectAutomationSchedule.members[0].fields.timeZone;

/** Script names are typed on the command line, so they stay shell-friendly. */
export const AutomationScriptName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

const CronExpression = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      (value.split(/\s+/).length === 5 && Result.isSuccess(Cron.parse(value))) ||
      "Expected a five-field cron expression (minute hour day month weekday)",
  ),
);

export const AutomationSchedule = Schema.Union([
  ...ProjectAutomationSchedule.members,
  Schema.Struct({
    kind: Schema.Literal("weekdays"),
    time: Time,
    days: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(
      Schema.isMinLength(1),
    ),
    timeZone: TimeZone,
  }),
  Schema.Struct({ kind: Schema.Literal("cron"), expression: CronExpression, timeZone: TimeZone }),
]);
export type AutomationSchedule = typeof AutomationSchedule.Type;

/**
 * Things that happen and can fire an automation. Each fires once per new state: a pull request
 * linked to a thread in the project, a linked pull request's checks turning failing, an issue in
 * the owner's project repositories gaining a label, a thread in the project waiting for approval
 * or input or its session failing, and a new GitHub release in a repository.
 */
export const AutomationEventKind = Schema.Literals([
  "pull-request.opened",
  "ci.failed",
  "issue.labeled",
  "worker.blocked",
  "release.published",
]);
export type AutomationEventKind = typeof AutomationEventKind.Type;

/** Every set field must match. `repository` is `owner/name`. */
export const AutomationEventFilter = Schema.Struct({
  repository: Schema.optionalKey(TrimmedNonEmptyString),
  label: Schema.optionalKey(TrimmedNonEmptyString),
  threadId: Schema.optionalKey(ThreadId),
});
export type AutomationEventFilter = typeof AutomationEventFilter.Type;

export const AutomationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("schedule"), schedule: AutomationSchedule }),
  Schema.Struct({
    type: Schema.Literal("event"),
    event: AutomationEventKind,
    filter: Schema.optionalKey(AutomationEventFilter),
  }),
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

export const AutomationAgentTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new-thread") }),
  Schema.Struct({ kind: Schema.Literal("existing-thread"), threadId: ThreadId }),
]);
export type AutomationAgentTarget = typeof AutomationAgentTarget.Type;

/**
 * What a script run does with its findings. `review` files nothing and leaves the thread open for
 * Brad to read; `file-only` files findings as requests; `file-and-settle` also settles the thread.
 * The mode is spelled out at the end of the run's prompt.
 */
export const AutomationResultMode = Schema.Literals(["review", "file-only", "file-and-settle"]);
export type AutomationResultMode = typeof AutomationResultMode.Type;

/** Start an agent turn from a saved script or an inline prompt. */
export const AutomationAgentAction = Schema.Struct({
  type: Schema.Literal("agent"),
  script: Schema.optionalKey(AutomationScriptName),
  prompt: Schema.optionalKey(Prompt),
  /** Overrides the script's mode; an inline prompt gets no mode unless one is set here. */
  resultMode: Schema.optionalKey(AutomationResultMode),
  target: AutomationAgentTarget,
}).check(
  Schema.makeFilter(
    (action) =>
      (action.script === undefined) !== (action.prompt === undefined) ||
      "Choose either a script or a prompt",
  ),
);
export const AutomationAction = Schema.Union([AutomationAgentAction]);
export type AutomationAction = typeof AutomationAction.Type;

export const AutomationDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  name: Name,
  enabled: Schema.Boolean,
  /** Orchestrator the automation reports to; new threads nest under it. */
  ownerThreadId: Schema.optionalKey(ThreadId),
  /** Empty means the automation only runs by hand. */
  triggers: Schema.Array(AutomationTrigger).check(Schema.isMaxLength(10)),
  actions: Schema.Array(AutomationAction).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});
export type AutomationDefinition = typeof AutomationDefinition.Type;

export const Automation = Schema.Struct({
  ...AutomationDefinition.fields,
  nextRunAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Automation = typeof Automation.Type;

export const AutomationRunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

/** One action's progress within a run. Agent steps own the thread and message they start. */
export const AutomationRunStep = Schema.Struct({
  kind: Schema.Literal("agent"),
  status: AutomationRunStatus,
  target: AutomationAgentTarget,
  threadId: ThreadId,
  messageId: MessageId,
  title: Schema.String,
  prompt: Schema.String,
  script: Schema.optionalKey(Schema.String),
  resultMode: Schema.optionalKey(AutomationResultMode),
  result: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type AutomationRunStep = typeof AutomationRunStep.Type;

export const AutomationRunTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("schedule"), scheduledAt: IsoDateTime }),
  Schema.Struct({ kind: Schema.Literal("manual") }),
  /** What the run saw: the event, in words, and where to look. */
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: AutomationEventKind,
    summary: Schema.String,
    url: Schema.optionalKey(Schema.String),
    occurredAt: IsoDateTime,
  }),
]);

export const AutomationRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  automationId: TrimmedNonEmptyString,
  projectId: ProjectId,
  name: Schema.String,
  /** Same automation + key never fires twice. */
  dedupeKey: TrimmedNonEmptyString,
  trigger: AutomationRunTrigger,
  ownerThreadId: Schema.optionalKey(ThreadId),
  dryRun: Schema.Boolean,
  status: AutomationRunStatus,
  result: Schema.NullOr(Schema.String),
  steps: Schema.Array(AutomationRunStep),
  createdAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type AutomationRun = typeof AutomationRun.Type;

export const AutomationScriptDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** Null makes the script global: every project's automations and runs can use it. */
  projectId: Schema.NullOr(ProjectId),
  name: AutomationScriptName,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  prompt: Prompt,
  /** Defaults to `review`. */
  resultMode: Schema.optionalKey(AutomationResultMode),
});
export type AutomationScriptDefinition = typeof AutomationScriptDefinition.Type;

export const AutomationScript = Schema.Struct({
  ...AutomationScriptDefinition.fields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AutomationScript = typeof AutomationScript.Type;

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}

/** Omit projectId to list every project's automations on the server. */
export const AutomationsListInput = Schema.Struct({ projectId: Schema.optionalKey(ProjectId) });
export const AutomationsListResult = Schema.Struct({ automations: Schema.Array(Automation) });
export const AutomationIdInput = Schema.Struct({ automationId: TrimmedNonEmptyString });
export const AutomationSetEnabledInput = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export const AutomationRunInput = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  dryRun: Schema.optionalKey(Schema.Boolean),
});
export const AutomationRunsInput = Schema.Struct({
  automationId: Schema.optionalKey(TrimmedNonEmptyString),
  projectId: Schema.optionalKey(ProjectId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export const AutomationRunsResult = Schema.Struct({ runs: Schema.Array(AutomationRun) });

/** Project scripts plus global ones; omit projectId for the global library only. */
export const AutomationScriptsListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export const AutomationScriptsListResult = Schema.Struct({
  scripts: Schema.Array(AutomationScript),
});
export const AutomationScriptIdInput = Schema.Struct({ scriptId: TrimmedNonEmptyString });
/** Run a script by hand: a new thread in the project, or a turn in an existing thread. */
export const AutomationScriptRunInput = Schema.Struct({
  projectId: ProjectId,
  script: AutomationScriptName,
  target: Schema.optionalKey(AutomationAgentTarget),
  ownerThreadId: Schema.optionalKey(ThreadId),
  resultMode: Schema.optionalKey(AutomationResultMode),
  dryRun: Schema.optionalKey(Schema.Boolean),
});
