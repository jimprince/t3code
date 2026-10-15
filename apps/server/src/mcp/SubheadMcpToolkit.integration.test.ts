import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, ServerProvider, SubheadRunReceipt, ThreadId } from "@t3tools/contracts";
import { McpServer, McpSchema } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vite-plus/test";
import { AutomationEngine } from "../automations/AutomationEngine.ts";
import { AutomationStore } from "../automations/AutomationStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as ProviderMock from "../provider/testUtils/providerRegistryMock.ts";
import { makeSubheadRegistry } from "../forkThreads/SubheadRegistry.ts";
import {
  subheadNativeLayer,
  subheadModel,
  subheadProject,
  createSubheadTestThread,
  sendSubheadTestMessage,
} from "../forkThreads/SubheadNative.testkit.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment");
const head = ThreadId.make("head");
const caller = ThreadId.make("caller");
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "fixture",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00.000Z",
  models: [],
});
const layer = McpHttpServer.layerSubheadToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mergeAll(subheadNativeLayer, Projects.layer.pipe(Layer.provide(subheadNativeLayer))),
  ),
  Layer.provide(ProviderMock.layer([provider])),
  Layer.provide(Layer.mock(AutomationEngine)({ refresh: Effect.void })),
  Layer.provide(Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) })),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "subhead-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "subhead-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope = (threadId = caller): McpInvocationScope => ({
  environmentId,
  requestNamespace: `thread:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    providerInstanceId: subheadModel.instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${subheadProject},'Fixture','/tmp','[]','2026-10-15T00:00:00.000Z','2026-10-15T00:00:00.000Z')`;
  yield* createSubheadTestThread(head);
  yield* createSubheadTestThread(caller);
  yield* sendSubheadTestMessage(caller);
  const registry = yield* makeSubheadRegistry;
  yield* registry.create({
    name: "review",
    projectId: subheadProject,
    ownerThreadId: head,
    description: "Review",
    prompt: "Frozen",
    modelSelection: subheadModel,
    runtimeMode: "full-access",
    concurrency: 1,
  });
  yield* registry.setState("review", "enable");
  const server = yield* McpServer.McpServer;
  return (name: string, args: Record<string, unknown>, as = scope()) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, as),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
});
const request = { name: "review", request: "Review this", clientRequestId: "stable" };
const receipt = Schema.decodeUnknownSync(SubheadRunReceipt);

it.layer(NodeServices.layer)("subhead MCP transport", (it) => {
  it.effect(
    "uses authenticated thread identity, returns the same receipt on retry and reads the shared run",
    () =>
      Effect.gen(function* () {
        const invoke = yield* setup;
        const first = yield* invoke("subhead_send", request);
        expect(first.isError).toBe(false);
        const a = receipt(first.structuredContent);
        const b = receipt((yield* invoke("subhead_send", request)).structuredContent);
        expect(a.runId).toBe(b.runId);
        const store = yield* AutomationStore;
        const runs = yield* store.listRuns({ limit: 100 });
        expect(runs).toHaveLength(1);
        expect(runs[0]?.virtualSubhead?.senderThreadId).toBe(caller);
        expect(runs[0]?.ownerThreadId).toBe(head);
        expect(
          receipt((yield* invoke("subhead_status", { runId: a.runId })).structuredContent).runId,
        ).toBe(a.runId);
        expect(
          (yield* invoke("subhead_result", { runId: a.runId })).structuredContent,
        ).toMatchObject({ runId: a.runId, result: null });
      }).pipe(Effect.provide(layer)),
  );
  it.effect("rejects return identity overrides, read-only writes and permission escalation", () =>
    Effect.gen(function* () {
      const invoke = yield* setup;
      expect(
        (yield* invoke("subhead_send", { ...request, senderThreadId: "victim" })).isError,
      ).toBe(true);
      const outside: McpInvocationScope = {
        ...scope(),
        thread: undefined,
        requestNamespace: "outside",
        client: { sessionId: "outside", label: "Outside", access: "read-only" },
      };
      expect((yield* invoke("subhead_send", request, outside)).isError).toBe(true);
      const limited = ThreadId.make("limited");
      yield* createSubheadTestThread(limited, "approval-required");
      yield* sendSubheadTestMessage(limited);
      expect((yield* invoke("subhead_send", request, scope(limited))).isError).toBe(true);
      expect(yield* (yield* AutomationStore).listRuns({ limit: 100 })).toHaveLength(0);
      expect((yield* invoke("subhead_send", request)).isError).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("denies authenticated virtual-run recursion without creating another ledger row", () =>
    Effect.gen(function* () {
      const invoke = yield* setup;
      const first = yield* invoke("subhead_send", request);
      expect(first.isError).toBe(false);
      const store = yield* AutomationStore;
      const run = (yield* store.listRuns({ limit: 100 }))[0]!;
      const execution = run.steps[0]!.threadId;
      yield* createSubheadTestThread(execution);
      yield* sendSubheadTestMessage(execution);
      expect(
        (yield* invoke(
          "subhead_send",
          { ...request, clientRequestId: "recursive" },
          scope(execution),
        )).isError,
      ).toBe(true);
      expect(yield* store.listRuns({ limit: 100 })).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
});
