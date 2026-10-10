import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SavedEnvironment } from "../../../t3-thread/src/types.ts";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcGroup, RpcServer, RpcSerialization } from "effect/unstable/rpc";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  ThreadRecoveryRpcs,
  RpcScopeAuthorization,
  type SessionResetReceipt,
  type HandoverHostReceipt,
} from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecrets from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { rpcScopeAuthorizationLayer } from "../auth/RpcAuthorization.ts";
import * as ResetHook from "./ProviderSessionResetHook.ts";
import * as HostRouteTransfer from "./HostRouteTransfer.ts";
import { authenticatedHandlers } from "./rpc.ts";
import { layer, config, database, seed, input, old, successor } from "./Recovery.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const auth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(database),
  Layer.provide(ServerSecrets.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(config),
);
const hostIdentity = Layer.effect(
  ServerEnvironment.ServerEnvironment,
  Effect.gen(function* () {
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    return ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: identity.getEnvironmentId,
      getDescriptor: Effect.die("descriptor unused"),
    });
  }),
).pipe(Layer.provide(ServerEnvironment.identityLayer), Layer.provide(config));
const runtime = Layer.mergeAll(
  auth,
  HostRouteTransfer.layer.pipe(Layer.provide(hostIdentity)),
).pipe(Layer.provideMerge(layer), Layer.provide(NodeServices.layer));

it.live(
  "real CLI client exchanges a scoped token for a websocket ticket; standard token is refused and administrative reset/route transfer works",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "recovery-routes-" });
        const previous = process.env.T3_AGENT_STATE_FILE;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.T3_AGENT_STATE_FILE = `${directory}/state.json`;
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.T3_AGENT_STATE_FILE;
              else process.env.T3_AGENT_STATE_FILE = previous;
            }),
        );
        yield* fs.writeFileString(
          `${directory}/state.json`,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            subscriptions: [
              {
                subscriberThreadId: old,
                subscriberEnvironment: "target",
                sourceThreadId: "child",
                sourceEnvironment: "mac",
                inactivityMinutes: 17,
                level: "attention",
                baselineTurnId: "turn-1",
              },
            ],
            agents: [],
            notifications: [],
            queuedSends: [],
          }),
        );
        yield* seed();
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const group = RpcGroup.make(...ThreadRecoveryRpcs).middleware(RpcScopeAuthorization);
        const routes = HttpRouter.use((router) =>
          Effect.gen(function* () {
            yield* router.add(
              "POST",
              "/api/auth/websocket-ticket",
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const session = yield* auth.authenticateHttpRequest(request);
                return yield* HttpServerResponse.json(yield* auth.issueWebSocketTicket(session));
              }),
            );
            yield* router.add(
              "GET",
              "/ws",
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const session = yield* auth.authenticateWebSocketUpgrade(request);
                const effect = yield* RpcServer.toHttpEffectWebsocket(group).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      group.toLayer(
                        authenticatedHandlers({
                          principal: session.subject,
                          scopes: session.scopes,
                        }),
                      ),
                      rpcScopeAuthorizationLayer(session.scopes),
                      RpcSerialization.layerJson,
                    ),
                  ),
                );
                return yield* effect;
              }),
            );
          }),
        );
        yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixPathAddress") return yield* Effect.die("TCP required");
        const url = `http://127.0.0.1:${server.address.port}`;
        // Compile the Promise-based CLI in its own package; exercise its actual implementation here.
        const cliPath = new URL("../../../t3-thread/src/client.ts", import.meta.url).href;
        const cli: {
          RemoteEnvironmentClient: new (environment: SavedEnvironment) => {
            recoveryRpc: <A = unknown>(method: string, input: unknown) => Promise<A>;
          };
        } = yield* Effect.tryPromise(() => import(cliPath));
        const build = (token: string) =>
          new cli.RemoteEnvironmentClient({
            name: "test",
            httpBaseUrl: url,
            wsBaseUrl: url.replace("http:", "ws:") + "/ws",
            environmentId: "test",
            label: "test",
            serverVersion: "test",
            bearerToken: token,
            expiresAt: "2099-01-01T00:00:00Z",
            pairedAt: "2026-10-10T00:00:00Z",
          });
        const standard = yield* auth.issueSession({ scopes: AuthStandardClientScopes });
        const admin = yield* auth.issueSession({
          scopes: AuthAdministrativeScopes,
          subject: "deployment-admin",
        });
        const denied = yield* Effect.tryPromise(() =>
          build(standard.token).recoveryRpc("thread.session.reset", input),
        ).pipe(Effect.asVoid, Effect.flip);
        expect(denied.cause).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: "access:write",
        });
        const client = build(admin.token);
        const receipt = yield* Effect.tryPromise(() =>
          client.recoveryRpc<SessionResetReceipt>("thread.session.reset", input),
        );
        expect(receipt.status).toBe("completed");
        expect(receipt.principal).toBe("deployment-admin");
        const routesInput = {
          transferId: "handover-test",
          oldThreadId: old,
          successorThreadId: successor,
          targetEnvironment: "target",
          expectedGeneration: 0,
          requestId: "routes-1",
          reason: "operator",
        };
        const transferred = yield* Effect.tryPromise(() =>
          client.recoveryRpc<HandoverHostReceipt>("thread.handover.routes", routesInput),
        );
        expect(transferred.items[0]?.after).toMatchObject({
          subscriberThreadId: successor,
          inactivityMinutes: 17,
          baselineTurnId: "turn-1",
        });
        expect(transferred.digest).toHaveLength(64);
        expect(
          yield* Effect.tryPromise(() =>
            client.recoveryRpc<HandoverHostReceipt>("thread.handover.routes", routesInput),
          ),
        ).toEqual(transferred);
        const readback = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              subscriptions: Schema.Array(Schema.Struct({ subscriberThreadId: Schema.String })),
              handoverReceipts: Schema.Array(Schema.Unknown),
            }),
          ),
        )(yield* fs.readFileString(`${directory}/state.json`));
        expect(readback.subscriptions[0]?.subscriberThreadId).toBe(successor);
        expect(readback.handoverReceipts).toHaveLength(1);
      }),
    ).pipe(
      Effect.provideService(ResetHook.ProviderSessionResetHook, {
        reset: () => Effect.succeed({ isolation: "thread", stopped: true }),
      }),
      Effect.provide(Layer.mergeAll(runtime, NodeHttpServer.layerTest)),
    ),
);
