import { it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import { expect } from "vite-plus/test";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Settings from "../serverSettings.ts";
import * as HarnessPin from "./HarnessPinService.ts";
import { group, handlers } from "./rpcHandlers.ts";

// Settings are exposed beside the handlers, so a test reads what the handler really wrote.
const layer = group
  .toLayer(handlers)
  .pipe(Layer.provide(HarnessPin.layer), Layer.provideMerge(Settings.layerTest()));

it.effect("pins and unpins through the production WS handler with operate scope", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(group);
    const settings = yield* Settings.ServerSettingsService;
    const set = (pinned: boolean) =>
      client["harness.setCheckPinned"]({ checkKey: "env:automation:audit", pinned });
    expect(yield* set(true)).toEqual({ pinnedCheckKeys: ["env:automation:audit"] });
    // The pin really reached the settings the snapshot reads.
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual(["env:automation:audit"]);
    // The same pin twice changes nothing.
    expect(yield* set(true)).toEqual({ pinnedCheckKeys: ["env:automation:audit"] });
    expect(yield* set(false)).toEqual({ pinnedCheckKeys: [] });
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual([]);
  }).pipe(
    Effect.provide(Layer.mergeAll(layer, RpcAuthorization.layer([AuthOrchestrationOperateScope]))),
    Effect.scoped,
  ),
);

it.effect("refuses the WS pin RPC with read scope only and leaves the pins alone", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const client = yield* RpcTest.makeClient(group);
    const refused = yield* client["harness.setCheckPinned"]({
      checkKey: "env:automation:audit",
      pinned: true,
    }).pipe(Effect.flip);
    expect(refused).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual([]);
  }).pipe(
    Effect.provide(Layer.mergeAll(layer, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
    Effect.scoped,
  ),
);
