import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as HarnessPin from "../../../harness/HarnessPinService.ts";
import { HarnessReadService } from "../../../harness/HarnessReadService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment:harness");
const threadId = ThreadId.make("thread:harness");
const scope = (id: EnvironmentId): McpInvocationContext.McpInvocationScope => ({
  environmentId: id,
  requestNamespace: "provider:harness",
  thread: {
    threadId,
    providerSessionId: "provider:harness",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "harness", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "harness", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const layerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});
/** The /mcp registration with a caller thread whose shell has these modes. */
const layerForCaller = (modes: Parameters<typeof liveThreadShell>[1] = {}) =>
  McpHttpServer.layerHarnessToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id, modes)),
      }),
    ),
    Layer.provide(layerEnvironment),
    Layer.provide(Layer.mock(HarnessReadService)({})),
    Layer.provide(HarnessPin.layer),
    Layer.provideMerge(Settings.layerTest()),
  );
const layer = layerForCaller();

it.effect("pins, repeats and unpins a check through the /mcp registration and reads it back", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (args: Record<string, unknown>, as = environmentId) =>
      server
        .callTool({ name: "harness_check_pin", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope(as)),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const pinned = yield* call({ checkKey: "env:automation:audit", pinned: true });
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toEqual({ pinnedCheckKeys: ["env:automation:audit"] });
    const again = yield* call({ checkKey: "env:automation:audit", pinned: true });
    expect(again.structuredContent).toEqual({ pinnedCheckKeys: ["env:automation:audit"] });
    // A key no check reports is still unpinnable, so a stale pin never sticks.
    const settings = yield* Settings.ServerSettingsService;
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual(["env:automation:audit"]);
    const unpinned = yield* call({ checkKey: "env:automation:audit", pinned: false });
    expect(unpinned.structuredContent).toEqual({ pinnedCheckKeys: [] });
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a credential that belongs to another environment and a malformed key", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (args: Record<string, unknown>, as: EnvironmentId) =>
      server
        .callTool({ name: "harness_check_pin", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope(as)),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const foreign = yield* call(
      { checkKey: "env:automation:audit", pinned: true },
      EnvironmentId.make("environment:other"),
    );
    expect(foreign.isError).toBe(true);
    // A malformed key never reaches the handler: the protocol rejects the parameters.
    const empty = yield* call({ checkKey: "", pinned: true }, environmentId).pipe(Effect.exit);
    expect(Exit.isFailure(empty)).toBe(true);
    const settings = yield* Settings.ServerSettingsService;
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a caller that is not full-access and leaves the pins alone", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const refused = yield* server
      .callTool({
        name: "harness_check_pin",
        arguments: { checkKey: "env:automation:audit", pinned: true },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope(environmentId)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.structuredContent ?? refused.content)).toMatch(/full-access/);
    const settings = yield* Settings.ServerSettingsService;
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual([]);
  }).pipe(Effect.provide(layerForCaller({ runtimeMode: "approval-required" }))),
);
