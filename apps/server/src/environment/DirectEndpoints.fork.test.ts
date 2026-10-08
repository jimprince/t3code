import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeOS from "node:os";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { resolveAvailableEditorsForConfig } from "../ws.ts";
import * as DirectEndpoints from "./DirectEndpoints.ts";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOS>()),
  networkInterfaces: vi.fn(),
}));

const networkInterfaces = vi.mocked(NodeOS.networkInterfaces);
afterEach(() => networkInterfaces.mockReset());

const resolve = (host: string | undefined) => {
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({
      ...config,
      host,
      port: 3773,
      tailscaleServeEnabled: false,
    })),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-direct-enumeration-" })),
    Layer.provide(NodeServices.layer),
  );
  return Effect.flatMap(DirectEndpoints.DirectEndpoints, (service) => service.resolve()).pipe(
    Effect.provide(
      DirectEndpoints.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            configLayer,
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.die("unexpected process")),
            ),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unexpected HTTP request")),
            ),
          ),
        ),
      ),
    ),
  );
};

const enumerationError = () => Object.assign(new Error("uv_interface_addresses"), { errno: 97 });

describe("DirectEndpoints interface enumeration", () => {
  it.effect("never enumerates interfaces for a loopback host", () =>
    Effect.gen(function* () {
      networkInterfaces.mockImplementation(() => {
        throw enumerationError();
      });
      expect(yield* resolve("127.0.0.1")).toEqual([]);
      expect(networkInterfaces).not.toHaveBeenCalled();
    }),
  );

  it.effect("advertises a specific private host without enumerating interfaces", () =>
    Effect.gen(function* () {
      networkInterfaces.mockImplementation(() => {
        throw enumerationError();
      });
      expect(yield* resolve("192.168.1.10")).toEqual([
        { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      ]);
      expect(networkInterfaces).not.toHaveBeenCalled();
    }),
  );

  it.effect("still advertises LAN and tailnet addresses for a wildcard host", () =>
    Effect.gen(function* () {
      const entry = (address: string): NodeOS.NetworkInterfaceInfo => ({
        address,
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: `${address}/24`,
      });
      networkInterfaces.mockReturnValue({
        eth0: [entry("192.168.1.10")],
        tailscale0: [entry("100.101.102.103")],
      });
      expect(yield* resolve("0.0.0.0")).toEqual([
        { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
        { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
      ]);
      expect(networkInterfaces).toHaveBeenCalledOnce();
    }),
  );

  it.effect("drops bound addresses when wildcard enumeration throws errno 97", () =>
    Effect.gen(function* () {
      networkInterfaces.mockImplementation(() => {
        throw enumerationError();
      });
      expect(yield* resolve("0.0.0.0")).toEqual([]);
      expect(networkInterfaces).toHaveBeenCalledOnce();
    }),
  );

  it.effect("succeeds through getConfig's discovery wrapper when enumeration throws", () =>
    Effect.gen(function* () {
      networkInterfaces.mockImplementation(() => {
        throw enumerationError();
      });
      expect(yield* resolveAvailableEditorsForConfig(resolve("::"))).toEqual([]);
      expect(networkInterfaces).toHaveBeenCalledOnce();
    }),
  );

  it.effect("preserves unrelated typed failures through the config wrapper", () =>
    Effect.gen(function* () {
      const failure = new Error("settings unavailable");
      expect(yield* resolveAvailableEditorsForConfig(Effect.fail(failure)).pipe(Effect.flip)).toBe(
        failure,
      );
    }),
  );

  it.effect("preserves unrelated defects through the config wrapper", () =>
    Effect.gen(function* () {
      const failure = new Error("auth defect");
      const exit = yield* resolveAvailableEditorsForConfig(Effect.die(failure)).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure);
    }),
  );
});
