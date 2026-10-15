import {
  NamedAgentError,
  type AutomationRun,
  type SubheadInput,
  type SubheadRunReceipt,
  type SubheadSendInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AutomationEngine } from "../automations/AutomationEngine.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { makeSubheadRegistryRpc } from "./SubheadRegistryRpc.ts";
import { makeSubheadRuns, type SubheadCaller } from "./SubheadRuns.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

/** CLI and MCP share this service; authentication supplies their different caller kinds. */
export const makeSubheadApi = Effect.gen(function* () {
  const registry = yield* makeSubheadRegistryRpc;
  const runs = yield* makeSubheadRuns;
  const engine = yield* AutomationEngine;
  const environment = yield* ServerEnvironment;
  const threads = yield* Threads.ThreadManagementService;
  const receipt = (run: AutomationRun) =>
    Effect.gen(function* () {
      const virtual = run.virtualSubhead!;
      const execution = run.steps[0]?.threadId;
      const shell = execution
        ? yield* threads
            .getThreadShell(execution)
            .pipe(Effect.mapError((cause) => new NamedAgentError({ message: String(cause) })))
        : null;
      return {
        runId: run.id,
        virtualAgentId: virtual.agentId,
        requestId: virtual.requestId,
        templateVersion: virtual.template.version,
        templateHash: virtual.templateHash,
        status: run.status,
        threadId: shell?.id ?? null,
        delivery: virtual.delivery,
        blockedReason: virtual.blockedReason,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
      } satisfies SubheadRunReceipt;
    });
  const send = (caller: SubheadCaller, input: SubheadSendInput) =>
    runs.send(caller, input, registry.validate).pipe(
      Effect.tap(() => engine.refresh),
      Effect.flatMap(receipt),
    );
  const status = (caller: SubheadCaller, runId: string) =>
    runs.read(caller, runId).pipe(Effect.flatMap(receipt));
  const result = (caller: SubheadCaller, runId: string) =>
    Effect.gen(function* () {
      const run = yield* runs.read(caller, runId);
      return { ...(yield* receipt(run)), result: run.result };
    });
  const handle = (caller: SubheadCaller, input: SubheadInput) =>
    Effect.gen(function* () {
      switch (input.operation) {
        case "send":
          return yield* send(caller, {
            name: input.name,
            requestId: input.requestId,
            request: input.request,
          });
        case "status":
          return yield* status(caller, input.runId);
        case "result":
          return yield* result(caller, input.runId);
        default:
          return yield* registry
            .handle(input, caller.principal)
            .pipe(Effect.tap(() => engine.refresh));
      }
    });
  const handlePrincipal = (principal: string, input: SubheadInput) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      return yield* handle(
        { environmentId, principal, threadId: null, runtimeMode: "full-access" },
        input,
      );
    });
  return { handle, handlePrincipal, send, status, result };
});
