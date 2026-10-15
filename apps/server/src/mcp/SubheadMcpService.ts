import {
  OrchestratorMcpFailure,
  type SubheadMcpSendInput,
  type SubheadRunReceipt,
  type SubheadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class SubheadMcpService extends Context.Service<
  SubheadMcpService,
  {
    readonly send: (
      scope: McpInvocationScope,
      input: SubheadMcpSendInput,
    ) => Effect.Effect<SubheadRunReceipt, OrchestratorMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
      runId: string,
    ) => Effect.Effect<SubheadRunReceipt, OrchestratorMcpFailure>;
    readonly result: (
      scope: McpInvocationScope,
      runId: string,
    ) => Effect.Effect<SubheadResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/SubheadMcpService") {}

const missing = Effect.fail(
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Subhead MCP transport not implemented.",
  }),
);
export const layer = Layer.succeed(SubheadMcpService, {
  send: () => missing,
  status: () => missing,
  result: () => missing,
});
