import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { AutomationRunStatus } from "./automations.ts";
import { NamedAgentError } from "./namedAgents.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  SubheadRegistryInput,
  SubheadRegistryResult,
  SubheadSendInput,
  VirtualSubheadRun,
} from "./subheads.ts";

/** Public receipts keep large frozen prompts in the run history rather than every response. */
export const SubheadRunReceipt = Schema.Struct({
  runId: TrimmedNonEmptyString,
  virtualAgentId: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  templateVersion: Schema.Int,
  templateHash: TrimmedNonEmptyString,
  status: AutomationRunStatus,
  threadId: Schema.NullOr(ThreadId),
  delivery: VirtualSubheadRun.fields.delivery,
  blockedReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type SubheadRunReceipt = typeof SubheadRunReceipt.Type;
export const SubheadResult = Schema.Struct({
  ...SubheadRunReceipt.fields,
  result: Schema.NullOr(Schema.String),
});
export type SubheadResult = typeof SubheadResult.Type;
export const SubheadRunIdInput = Schema.Struct({ runId: TrimmedNonEmptyString });
export const SubheadMcpSendInput = Schema.Struct({
  name: SubheadSendInput.fields.name,
  request: SubheadSendInput.fields.request,
  clientRequestId: SubheadSendInput.fields.requestId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SubheadMcpSendInput = typeof SubheadMcpSendInput.Type;

export const SubheadInput = Schema.Union([
  SubheadRegistryInput,
  Schema.Struct({ operation: Schema.Literal("send"), ...SubheadSendInput.fields }),
  Schema.Struct({ operation: Schema.Literals(["status", "result"]), runId: TrimmedNonEmptyString }),
]);
export type SubheadInput = typeof SubheadInput.Type;
export const SubheadRpc = Rpc.make("fork.subheads", {
  payload: SubheadInput,
  success: Schema.Union([SubheadRegistryResult, SubheadResult, SubheadRunReceipt]),
  error: Schema.Union([NamedAgentError, EnvironmentAuthorizationError]),
});
