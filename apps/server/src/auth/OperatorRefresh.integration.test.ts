import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  layer as authHttpApiLayer,
  layerAuthenticatedAuth as environmentAuthenticatedAuthLayer,
} from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  // The token-exchange route resolves Crypto and the secret store per request.
  HttpRouter.provideRequest(
    Layer.mergeAll(
      NodeCrypto.layer,
      ServerSecretStore.layer.pipe(Layer.provide(configLayer), Layer.provide(NodeServices.layer)),
    ),
  ),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provideMerge(
    ServerEnvironment.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(configLayer),
    ),
  ),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("rotates scoped operator credentials through V2 HTTP with old-token overlap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(routesLayer.pipe(Layer.provideMerge(HttpRouter.layer)));
      const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
      const descriptor = yield* Context.get(context, ServerEnvironment.ServerEnvironment)
        .getDescriptor;
      expect(descriptor.orchestrationProtocolVersion).toBe(2);
      expect(descriptor.capabilities.sessionRefresh).toBe(true);
      const nearExpiry = yield* auth.issueSession({
        ttl: Duration.days(6),
        subject: "operator",
        scopes: ["orchestration:read"],
        label: "cli-device",
      });
      const expired = yield* auth.issueSession({ ttl: Duration.zero });
      const revoked = yield* auth.issueSession();
      yield* auth.revokeSession(revoked.sessionId);
      const web = HttpRouter.toWebHandler(Layer.succeedContext(context), { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
      const browser = yield* auth.createBrowserSession(DEV_TOKEN, { deviceType: "desktop" });
      const refresh = (token: string) =>
        web.handler(
          postJson("/api/auth/session/refresh", {}, { authorization: `Bearer ${token}` }),
          context,
        );
      const replacement = yield* Effect.tryPromise(async () => {
        const response = await refresh(nearExpiry.token);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("set-cookie")).toBeNull();
        const body = (await response.json()) as {
          access_token: string;
          scope: string;
          expires_in: number;
        };
        expect(body.scope).toBe("orchestration:read");
        expect(body.expires_in).toBeGreaterThan(29 * 86400);
        expect((await refresh(expired.token)).status).toBe(401);
        expect((await refresh(revoked.token)).status).toBe(401);
        expect((await refresh("invalid")).status).toBe(401);
        const cookie = await web.handler(
          postJson(
            "/api/auth/session/refresh",
            {},
            { cookie: `${browser.cookieName}=${browser.sessionToken}` },
          ),
          context,
        );
        expect(cookie.status).toBe(403);
        return body;
      });
      const authenticated = yield* auth.authenticateHttpRequest({
        cookies: {},
        headers: { authorization: `Bearer ${replacement.access_token}` },
      } as never);
      expect(authenticated.subject).toBe("operator");
      expect(authenticated.scopes).toEqual(["orchestration:read"]);
      expect(authenticated.client?.label).toBe("cli-device");
      const old = yield* auth.authenticateHttpRequest({
        cookies: {},
        headers: { authorization: `Bearer ${nearExpiry.token}` },
      } as never);
      expect(old.sessionId).toBe(nearExpiry.sessionId);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
