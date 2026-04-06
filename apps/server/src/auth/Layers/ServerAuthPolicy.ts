import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerAuthPolicy, type ServerAuthPolicyShape } from "../Services/ServerAuthPolicy.ts";

const SESSION_COOKIE_NAME = "t3_session";

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const makeServerAuthPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const policy =
    config.mode === "desktop"
      ? "desktop-managed-local"
      : isWildcardHost(config.host) || !isLoopbackHost(config.host)
        ? "remote-reachable"
        : "loopback-browser";

  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "desktop-managed-local" ? ["desktop-bootstrap"] : ["one-time-token"];

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: SESSION_COOKIE_NAME,
  };

  return {
    getDescriptor: () => Effect.succeed(descriptor),
  } satisfies ServerAuthPolicyShape;
});

export const ServerAuthPolicyLive = Layer.effect(ServerAuthPolicy, makeServerAuthPolicy);
