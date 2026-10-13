import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Pin from "./HarnessPinService.ts";
import * as Settings from "../serverSettings.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { group, handlers } from "./rpcHandlers.ts";

const layer = group
  .toLayer(handlers)
  .pipe(Layer.provide(Pin.layer.pipe(Layer.provide(Settings.layerTest()))));
it.effect("WS pin RPC returns the full list through the production handler", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(group);
    expect(yield* client["harness.checkPin.set"]({ checkKey: "a", pinned: true })).toEqual({
      pinnedCheckKeys: ["a"],
    });
    expect(yield* client["harness.checkPin.set"]({ checkKey: "a", pinned: true })).toEqual({
      pinnedCheckKeys: ["a"],
    });
    expect(yield* client["harness.checkPin.set"]({ checkKey: "a", pinned: false })).toEqual({
      pinnedCheckKeys: [],
    });
  }).pipe(
    Effect.provide(Layer.mergeAll(layer, RpcAuthorization.layer([AuthSettingsWriteScope]))),
    Effect.scoped,
  ),
);

it.effect("refuses the WS pin RPC without settings-write grants", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.mergeAll(layer, RpcAuthorization.layer([]))),
    );
    expect(
      yield* client["harness.checkPin.set"]({ checkKey: "a", pinned: true }).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthSettingsWriteScope,
    });
  }).pipe(Effect.scoped),
);
