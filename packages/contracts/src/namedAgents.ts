import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Named agents: a project that owns one resource (a printer, a deployment) and
 * runs through exactly one live top-level thread at a time. The project folder
 * holds AGENT.md (charter) and BRIEFING.md (current state), which seed every new
 * incarnation. Names are unique within an environment.
 */
export const NamedAgentName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/),
).pipe(Schema.brand("NamedAgentName"));
export type NamedAgentName = typeof NamedAgentName.Type;

export const PermanentAgent = Schema.Struct({
  name: NamedAgentName,
});
export type PermanentAgent = typeof PermanentAgent.Type;

export const NamedAgentSummary = Schema.Struct({
  name: NamedAgentName,
  projectId: ProjectId,
  /** The agent folder, which holds AGENT.md and BRIEFING.md. */
  workspaceRoot: TrimmedNonEmptyString,
  /** One-line scope from AGENT.md frontmatter, when readable. */
  scope: Schema.NullOr(Schema.String),
  /** The live incarnation, or null while the agent is dormant. */
  liveThreadId: Schema.NullOr(ThreadId),
});
export type NamedAgentSummary = typeof NamedAgentSummary.Type;

export const ListNamedAgentsResult = Schema.Struct({
  agents: Schema.Array(NamedAgentSummary),
});
export type ListNamedAgentsResult = typeof ListNamedAgentsResult.Type;

export const ResolveNamedAgentInput = Schema.Struct({
  name: NamedAgentName,
  /** Sent as part of the first turn when the agent has to be started. */
  message: Schema.optional(Schema.String),
});
export type ResolveNamedAgentInput = typeof ResolveNamedAgentInput.Type;

export const HandOverNamedAgentInput = Schema.Struct({
  name: NamedAgentName,
  message: Schema.optional(Schema.String),
});
export type HandOverNamedAgentInput = typeof HandOverNamedAgentInput.Type;

export const NamedAgentThreadResult = Schema.Struct({
  threadId: ThreadId,
  /** True when this call started a new incarnation (and delivered `message` with it). */
  started: Schema.Boolean,
});
export type NamedAgentThreadResult = typeof NamedAgentThreadResult.Type;

export class NamedAgentError extends Schema.TaggedError<NamedAgentError>()("NamedAgentError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
