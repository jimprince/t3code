import * as NodeModule from "node:module";
import { NodeHttpServer } from "@effect/platform-node";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { WsPlanPublishRpc, ThreadId, PlanId, type PlanPublicationInput } from "@t3tools/contracts";

it.effect(
  "publishes through the real CLI client and its narrow generated RPC group over WebSocket",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Runtime file URLs keep the CLI's sources under its own compiler settings.
        const [commands, clients, transport] = yield* Effect.all([
          Effect.tryPromise(
            () => import(new URL("../../../t3-thread/src/planCommands.ts", import.meta.url).href),
          ),
          Effect.tryPromise(
            () => import(new URL("../../../t3-thread/src/client.ts", import.meta.url).href),
          ),
          Effect.tryPromise(
            () => import(new URL("../../../t3-thread/src/rpc.ts", import.meta.url).href),
          ),
        ]);
        const { registerPlanCommands } = commands;
        const { RemoteEnvironmentClient } = clients;
        const { T3RpcClient } = transport;
        const calls: PlanPublicationInput[] = [];
        const group = RpcGroup.make(WsPlanPublishRpc);
        const result = {
          epic: { number: 7, url: "https://git.test/owner/tasks/issues/7" },
          tasks: [],
        };
        const handlers = group.toLayer({
          "fork.plan.publish": (input) =>
            Effect.sync(() => {
              calls.push(input);
              return result;
            }),
        });
        const routes = RpcServer.layerHttp({ group, path: "/rpc", protocol: "websocket" }).pipe(
          Layer.provide(handlers),
          Layer.provide(RpcSerialization.layerJson),
        );
        yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixPathAddress")
          return yield* Effect.die("Expected TCP server");
        const wsBaseUrl = `ws://127.0.0.1:${server.address.port}/rpc`;
        // Only authentication/discovery is bypassed. Requests and serialization use
        // RemoteEnvironmentClient -> T3RpcClient -> the production narrow WsRpcGroup.
        const client = new RemoteEnvironmentClient(
          {
            name: "test",
            httpBaseUrl: `http://127.0.0.1:${server.address.port}`,
            wsBaseUrl,
            environmentId: "test",
            label: "test",
            serverVersion: "test",
            bearerToken: "test",
            expiresAt: "2099-01-01T00:00:00.000Z",
            pairedAt: "2026-10-08T00:00:00.000Z",
          },
          { rpcFactory: (url: string) => new T3RpcClient(url) },
        );
        const input: PlanPublicationInput = {
          threadId: ThreadId.make("publisher"),
          title: "Parser",
          owner: "Manager",
          source: {
            type: "proposed_plan",
            threadId: ThreadId.make("publisher"),
            planId: PlanId.make("approved-plan"),
          },
        };
        const printed: unknown[] = [];
        // Resolve the CLI's existing dependency without adding one to the server.
        const { Command } = NodeModule.createRequire(
          new URL("../../../t3-thread/package.json", import.meta.url),
        )("commander");
        const program = new Command();
        registerPlanCommands(
          program.command("agent"),
          async () => ({ agent: { threadId: "publisher" }, client }),
          (value: unknown) => printed.push(value),
        );
        yield* Effect.tryPromise(() =>
          program.parseAsync([
            "node",
            "test",
            "agent",
            "plan",
            "publish",
            "publisher",
            "--title",
            "Parser",
            "--owner",
            "Manager",
            "--plan-id",
            "approved-plan",
          ]),
        );
        expect(printed).toEqual([result]);
        expect(calls).toEqual([input]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
