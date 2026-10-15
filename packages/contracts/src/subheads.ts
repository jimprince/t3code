import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { NamedAgentName } from "./namedAgents.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

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
