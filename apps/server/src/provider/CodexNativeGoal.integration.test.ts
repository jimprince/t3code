import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { CodexSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as CodexAdapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeReplayServerConfig } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

type Handler = (payload: unknown) => Effect.Effect<unknown>;
const program = Effect.gen(function* () {
  const handlers = new Map<string, Handler>();
  const goal = {
    objective: "Ship it",
    status: "active" as const,
    tokensUsed: 1200,
    tokenBudget: 4000,
  };
  let hydrateWithNotification = false;
  const request = ((method: string) =>
    Effect.gen(function* () {
      if (method === "thread/goal/get") {
        if (hydrateWithNotification) {
          yield* handlers.get("thread/goal/updated")!({
            threadId: "native-root",
            goal: { ...goal, objective: "Newer objective" },
          });
        }
        return { goal };
      }
      return {
        thread: {
          id: "native-root",
          createdAt: 1782622440,
          updatedAt: 1782622440,
          status: { type: "idle" },
        },
      };
    })) as CodexClient.CodexAppServerClient["Service"]["request"];
  const clientLayer = Layer.mock(CodexClient.CodexAppServerClient)({
    request,
    notify: () => Effect.void,
    raw: {
      request: () => Effect.succeed({ thread: { id: "native-root", updatedAt: 1782622440 } }),
    } as unknown as CodexClient.CodexAppServerClient["Service"]["raw"],
    handleServerNotification: (method, handler) =>
      Effect.sync(() => {
        handlers.set(method, handler as Handler);
      }),
    handleServerRequest: () => Effect.void,
  });
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientLayer),
  );
  const adapter = yield* CodexAdapter.makeCodexAdapterV2({
    instanceId: ProviderInstanceId.make("codex"),
    settings: yield* Schema.decodeEffect(CodexSettings)({}),
    environment: {},
    crypto: yield* Crypto.Crypto,
    clientFactory: { open: () => Effect.succeed(client) },
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* makeReplayServerConfig("native-goals"),
  });
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    cwd: "/tmp",
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  const threadId = ThreadId.make("root");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  assert.deepEqual(providerThread.codexNativeGoal, goal);
  assert.equal(yield* runtime.hasPendingBackgroundWork!, true);
  yield* handlers.get("thread/goal/updated")!({
    threadId: "native-child",
    goal: { ...goal, objective: "Child goal" },
  });
  yield* handlers.get("thread/goal/updated")!({
    threadId: "native-root",
    goal: { ...goal, status: "budgetLimited" },
  });
  assert.equal(yield* runtime.hasPendingBackgroundWork!, false);
  yield* handlers.get("thread/goal/cleared")!({ threadId: "native-root" });
  const events = yield* runtime.events.pipe(
    Stream.filter((event) => event.type === "provider_thread.updated"),
    Stream.take(2),
    Stream.runCollect,
  );
  assert.deepEqual(
    events.map((event) =>
      event.type === "provider_thread.updated" ? event.providerThread.codexNativeGoal : undefined,
    ),
    [{ ...goal, status: "blocked" }, null],
  );
  // A notification arriving during reconnect wins over the older goal/get snapshot.
  hydrateWithNotification = true;
  const resumed = yield* runtime.resumeThread({ providerThread, modelSelection, runtimePolicy });
  assert.equal(resumed.codexNativeGoal?.objective, "Newer objective");
  assert.equal(yield* runtime.hasPendingBackgroundWorkForThread!(providerThread), true);
});

it.effect(
  "hydrates read-only root goals, isolates child notifications, clears state and retains reconnect updates",
  () =>
    program.pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
);
