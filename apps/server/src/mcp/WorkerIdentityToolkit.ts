import { EnvironmentId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { readCaller } from "./threadAccess.ts";

/** Read identity from this invocation, never the SDK/server's shared process environment. */
export const readWorkerIdentity = Effect.fn("mcp.readWorkerIdentity")(function* () {
  const { scope } = yield* readCaller();
  const thread = yield* Invocation.requireThreadScope(scope, "t3_worker_identity");
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== scope.environmentId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  }
  return {
    threadId: thread.thread.threadId,
    environmentId: descriptor.environmentId,
    environmentName: descriptor.label,
  };
});

export const WorkerIdentityToolkit = Toolkit.make(
  Tool.make("t3_worker_identity", {
    description:
      "Read your own T3 thread and environment identity from this MCP session. For shell t3-thread commands set T3_THREAD_ID, T3_ENVIRONMENT_ID and T3_ENVIRONMENT_NAME to the returned values in that command's environment. Useful with Cursor and OpenCode shared runtimes where shell identity is unavailable. Never use another thread's identity or mutate a shared server environment.",
    success: Schema.Struct({
      threadId: ThreadId,
      environmentId: EnvironmentId,
      environmentName: Schema.String,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Invocation.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
      ServerEnvironment.ServerEnvironment,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
export const WorkerIdentityHandlersLive = McpToolAccess.toLayer(WorkerIdentityToolkit, {
  t3_worker_identity: McpToolAccess.readsAsCaller(() => readWorkerIdentity()),
});
