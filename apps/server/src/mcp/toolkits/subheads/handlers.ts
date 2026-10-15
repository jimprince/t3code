import * as Effect from "effect/Effect";
import { SubheadMcpService } from "../../SubheadMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { SubheadToolkit } from "./tools.ts";

const handlers = {
  subhead_send: Access.writes((input) =>
    Effect.gen(function* () {
      return yield* (yield* SubheadMcpService).send(yield* McpInvocationContext, input);
    }),
  ),
  subhead_status: Access.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* SubheadMcpService).status(yield* McpInvocationContext, input.runId);
    }),
  ),
  subhead_result: Access.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* SubheadMcpService).result(yield* McpInvocationContext, input.runId);
    }),
  ),
} satisfies Access.Handlers<typeof SubheadToolkit.tools>;
export const layer = Access.toLayer(SubheadToolkit, handlers);
