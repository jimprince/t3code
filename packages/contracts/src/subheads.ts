import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { NamedAgentName } from "./namedAgents.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";

/** App-owned snapshots. Edits never change an admitted run's template. */
export const SubheadTemplate = Schema.Struct({
  name: NamedAgentName,
  projectId: ProjectId,
  ownerThreadId: ThreadId,
  description: Schema.String.check(Schema.isMaxLength(500)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workspaceStrategy: Schema.optionalKey(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
});
export type SubheadTemplate = typeof SubheadTemplate.Type;
export const Subhead = Schema.Struct({
  ...SubheadTemplate.fields,
  id: TrimmedNonEmptyString,
  kind: Schema.Literal("virtual"),
  version: Schema.Int,
  enabled: Schema.Boolean,
  retiredAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  createdBy: Schema.optionalKey(Schema.String),
  updatedBy: Schema.optionalKey(Schema.String),
  /** Only on API responses, never stored: whether the caller may edit or change the state. */
  callerMayChange: Schema.optionalKey(Schema.Boolean),
});
export type Subhead = typeof Subhead.Type;

/** Stored on AutomationRun, never a second execution ledger. */
export const VirtualSubheadRun = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  template: Subhead,
  templateHash: TrimmedNonEmptyString,
  senderPrincipal: TrimmedNonEmptyString,
  senderThreadId: Schema.NullOr(ThreadId),
  requestId: TrimmedNonEmptyString,
  request: Schema.String,
  requestHash: TrimmedNonEmptyString,
  blockedReason: Schema.NullOr(Schema.String),
  leaseStartedAt: Schema.NullOr(IsoDateTime),
  terminationReason: Schema.NullOr(Schema.String),
  settlementPending: Schema.optionalKey(Schema.Boolean),
  delivery: Schema.Struct({
    id: TrimmedNonEmptyString,
    status: Schema.Literals(["pending", "pull-only", "held", "undelivered", "delivered"]),
    messageId: Schema.NullOr(Schema.String),
    attempts: Schema.Int,
    error: Schema.NullOr(Schema.String),
    firstAttemptAt: Schema.optionalKey(IsoDateTime),
    nextAttemptAt: Schema.optionalKey(IsoDateTime),
  }),
});
export type VirtualSubheadRun = typeof VirtualSubheadRun.Type;
export const SubheadSendInput = Schema.Struct({
  name: NamedAgentName,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  request: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
});
export type SubheadSendInput = typeof SubheadSendInput.Type;

export const SubheadRegistryInput = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("list"), all: Schema.Boolean }),
  Schema.Struct({ operation: Schema.Literal("show"), name: NamedAgentName }),
  Schema.Struct({ operation: Schema.Literal("create"), template: Schema.Unknown }),
  Schema.Struct({
    operation: Schema.Literal("edit"),
    name: NamedAgentName,
    template: Schema.Unknown,
    expectedVersion: Schema.Int,
  }),
  Schema.Struct({
    operation: Schema.Literal("state"),
    name: NamedAgentName,
    state: Schema.Literals(["enable", "disable", "retire"]),
  }),
]);
export type SubheadRegistryInput = typeof SubheadRegistryInput.Type;
export const SubheadRegistryResult = Schema.Union([
  Subhead,
  Schema.Struct({ agents: Schema.Array(Subhead) }),
]);
