import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import {
  readWorkerIdentity,
  WorkerIdentityToolkit,
  WorkerIdentityHandlersLive,
} from "./WorkerIdentityToolkit.ts";

const environmentId = EnvironmentId.make("environment");
function dependencies(threadId?: string, descriptorId = environmentId) {
  const providerInstanceId = ProviderInstanceId.make(
    threadId?.startsWith("opencode") ? "opencode2" : "cursor",
  );
  return Layer.mergeAll(
    Layer.succeed(Invocation.McpInvocationContext, {
      environmentId,
      requestNamespace: threadId ?? "external",
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
      thread: threadId
        ? {
            threadId: ThreadId.make(threadId),
            providerInstanceId,
            providerSessionId: `session:${threadId}`,
          }
        : undefined,
      client: undefined,
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          deletedAt: null,
          runtimeMode: "full-access",
          interactionMode: "default",
        } as OrchestrationV2ThreadShell),
    }),
    Layer.mock(Environment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: descriptorId,
        label: "Development",
      } as Effect.Success<Environment.ServerEnvironment["Service"]["getDescriptor"]>),
    }),
  );
}

describe("MCP-scoped worker identity", () => {
  it.effect("isolates concurrent Cursor and OpenCode sessions without changing global env", () =>
    Effect.gen(function* () {
      const before = process.env.T3_THREAD_ID;
      const identities = yield* Effect.forEach(
        ["cursor-thread", "opencode-thread"],
        (id) => readWorkerIdentity().pipe(Effect.provide(dependencies(id))),
        { concurrency: "unbounded" },
      );
      expect(identities).toEqual([
        { threadId: "cursor-thread", environmentId, environmentName: "Development" },
        { threadId: "opencode-thread", environmentId, environmentName: "Development" },
      ]);
      expect(process.env.T3_THREAD_ID).toBe(before);
    }),
  );
  it.effect("exposes caller identity through the registered tool handler", () =>
    Effect.gen(function* () {
      const deps = dependencies("cursor-thread");
      const result = yield* Effect.gen(function* () {
        const toolkit = yield* WorkerIdentityToolkit.pipe(
          Effect.provide(WorkerIdentityHandlersLive.pipe(Layer.provide(deps))),
        );
        return yield* toolkit
          .handle("t3_worker_identity", {})
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps));
      });
      expect(result.at(-1)?.result).toEqual({
        threadId: "cursor-thread",
        environmentId,
        environmentName: "Development",
      });
    }),
  );
  it.effect("refuses to guess identity for an external MCP client", () =>
    Effect.gen(function* () {
      const result = yield* readWorkerIdentity().pipe(Effect.provide(dependencies()), Effect.flip);
      expect(result.code).toBe("thread_credential_required");
    }),
  );
  it.effect("refuses another environment's credential", () =>
    Effect.gen(function* () {
      const result = yield* readWorkerIdentity().pipe(
        Effect.provide(dependencies("thread", EnvironmentId.make("other"))),
        Effect.flip,
      );
      expect(result.code).toBe("capability_denied");
    }),
  );
});
