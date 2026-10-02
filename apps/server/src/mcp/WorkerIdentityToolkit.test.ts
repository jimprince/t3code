import { describe, expect, it } from "vite-plus/test";
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
  it("isolates concurrent Cursor and OpenCode sessions without changing global env", async () => {
    const before = process.env.T3_THREAD_ID;
    const identities = await Promise.all(
      ["cursor-thread", "opencode-thread"].map((id) =>
        Effect.runPromise(readWorkerIdentity().pipe(Effect.provide(dependencies(id)))),
      ),
    );
    expect(identities).toEqual([
      { threadId: "cursor-thread", environmentId, environmentName: "Development" },
      { threadId: "opencode-thread", environmentId, environmentName: "Development" },
    ]);
    expect(process.env.T3_THREAD_ID).toBe(before);
  });
  it("exposes caller identity through the registered tool handler", async () => {
    const deps = dependencies("cursor-thread");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* WorkerIdentityToolkit.pipe(
          Effect.provide(WorkerIdentityHandlersLive.pipe(Layer.provide(deps))),
        );
        return yield* toolkit
          .handle("t3_worker_identity", {})
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps));
      }),
    );
    expect(result.at(-1)?.result).toEqual({
      threadId: "cursor-thread",
      environmentId,
      environmentName: "Development",
    });
  });
  it("refuses to guess identity for an external MCP client", async () => {
    const result = await Effect.runPromise(
      readWorkerIdentity().pipe(Effect.provide(dependencies()), Effect.flip),
    );
    expect(result.code).toBe("thread_credential_required");
  });
  it("refuses another environment's credential", async () => {
    const result = await Effect.runPromise(
      readWorkerIdentity().pipe(
        Effect.provide(dependencies("thread", EnvironmentId.make("other"))),
        Effect.flip,
      ),
    );
    expect(result.code).toBe("capability_denied");
  });
});
