import {
  OrchestratorMcpFailure,
  type SubheadMcpSendInput,
  type SubheadRunReceipt,
  type SubheadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { readCaller } from "./threadAccess.ts";
import { makeSubheadApi } from "../forkThreads/SubheadApi.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

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

export const layer = Layer.effect(
  SubheadMcpService,
  Effect.gen(function* () {
    const api = yield* makeSubheadApi;
    const threads = yield* ThreadManagementService;
    const caller = (scope: McpInvocationScope) =>
      readCaller().pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(ThreadManagementService, threads),
        Effect.map(({ limits }) => ({
          environmentId: scope.environmentId,
          principal: scope.thread
            ? `thread:${scope.thread.threadId}`
            : `mcp:${scope.client!.sessionId}`,
          threadId: scope.thread?.threadId ?? null,
          runtimeMode: limits.runtimeMode,
        })),
      );
    const failure = (cause: { readonly message: string }) =>
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: cause.message,
      });
    return {
      send: (scope, input) =>
        caller(scope).pipe(
          Effect.flatMap((identity) =>
            api
              .send(identity, {
                name: input.name,
                request: input.request,
                requestId: input.clientRequestId,
              })
              .pipe(Effect.mapError(failure)),
          ),
        ),
      status: (scope, runId) =>
        caller(scope).pipe(
          Effect.flatMap((identity) => api.status(identity, runId).pipe(Effect.mapError(failure))),
        ),
      result: (scope, runId) =>
        caller(scope).pipe(
          Effect.flatMap((identity) => api.result(identity, runId).pipe(Effect.mapError(failure))),
        ),
    } satisfies SubheadMcpService["Service"];
  }),
);
