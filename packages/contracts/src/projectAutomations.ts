import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, CommandId, MessageId } from "./baseSchemas.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const TimeZone = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
);
const Time = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
export const ProjectAutomationSchedule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("hourly"), timeZone: TimeZone }),
  Schema.Struct({ kind: Schema.Literal("daily"), time: Time, timeZone: TimeZone }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    time: Time,
    day: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
    timeZone: TimeZone,
  }),
]);
export type ProjectAutomationSchedule = typeof ProjectAutomationSchedule.Type;
export const ProjectAutomationDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  ownerThreadId: Schema.optionalKey(ThreadId),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  schedule: ProjectAutomationSchedule,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("new-thread") }),
    Schema.Struct({ kind: Schema.Literal("existing-thread"), threadId: ThreadId }),
  ]),
  enabled: Schema.Boolean,
});
export type ProjectAutomationDefinition = typeof ProjectAutomationDefinition.Type;
export const ProjectAutomationRun = Schema.Struct({
  name: TrimmedNonEmptyString,
  target: ProjectAutomationDefinition.fields.target,
  ownerThreadId: Schema.optionalKey(ThreadId),
  id: TrimmedNonEmptyString,
  scheduledAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  threadId: ThreadId,
  messageId: MessageId,
  prompt: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed", "skipped"]),
  result: Schema.NullOr(Schema.String),
});
export type ProjectAutomationRun = typeof ProjectAutomationRun.Type;
export const ProjectAutomation = Schema.Struct({
  ...ProjectAutomationDefinition.fields,
  nextRunAt: IsoDateTime,
  runs: Schema.Array(ProjectAutomationRun),
});
export type ProjectAutomation = typeof ProjectAutomation.Type;
const CommandFields = {
  commandId: CommandId,
  projectId: ProjectId,
  automationId: TrimmedNonEmptyString,
};
export const ProjectAutomationCommands = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.automation.create"),
    commandId: CommandId,
    projectId: ProjectId,
    automation: ProjectAutomationDefinition,
  }),
  Schema.Struct({
    type: Schema.Literal("project.automation.update"),
    commandId: CommandId,
    projectId: ProjectId,
    automation: ProjectAutomationDefinition,
  }),
  Schema.Struct({ type: Schema.Literal("project.automation.pause"), ...CommandFields }),
  Schema.Struct({ type: Schema.Literal("project.automation.resume"), ...CommandFields }),
  Schema.Struct({ type: Schema.Literal("project.automation.delete"), ...CommandFields }),
  Schema.Struct({ type: Schema.Literal("project.automation.run"), ...CommandFields }),
]);
export const ProjectAutomationInternalCommands = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.automation.fire"),
    ...CommandFields,
    scheduledAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("project.automation.run.update"),
    ...CommandFields,
    runId: TrimmedNonEmptyString,
    status: ProjectAutomationRun.fields.status,
    result: Schema.NullOr(Schema.String),
  }),
]);
