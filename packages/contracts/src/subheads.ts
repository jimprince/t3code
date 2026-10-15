import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { NamedAgentName } from "./namedAgents.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { NamedAgentError } from "./namedAgents.ts";

/** App-owned snapshots. Edits never change an admitted run's template. */
export const SubheadTemplate = Schema.Struct({
  name: NamedAgentName,
  projectId: ProjectId,
  ownerThreadId: ThreadId,
  description: Schema.String.check(Schema.isMaxLength(500)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
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
});
export type Subhead = typeof Subhead.Type;

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
export const SubheadRpc = Rpc.make("fork.subheads", {
  payload: SubheadRegistryInput,
  success: SubheadRegistryResult,
  error: Schema.Union([NamedAgentError, EnvironmentAuthorizationError]),
});
