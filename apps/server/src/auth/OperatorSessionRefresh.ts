import {
  AuthAccessTokenType,
  EnvironmentAuthenticatedPrincipal,
  type AuthSessionRefreshResult,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import type * as SessionStore from "./SessionStore.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentAuthInvalid,
  failEnvironmentOperationForbidden,
} from "./http.ts";

/** The old credential retains its original expiry so concurrent CLI calls and
 * an interrupted local save can safely retry without losing their pairing. */
export const makeOperatorSessionRefresh = (
  sessions: SessionStore.SessionStore["Service"],
): EnvironmentAuth.EnvironmentAuth["Service"]["refreshSession"] =>
  Effect.fn("EnvironmentAuth.refreshSession")(function* (session) {
    const now = yield* DateTime.now;
    const active = yield* sessions
      .listActive()
      .pipe(Effect.mapError((cause) => new EnvironmentAuth.ServerAuthSessionsListError({ cause })));
    const current = active.find((candidate) => candidate.sessionId === session.sessionId);
    if (
      session.method !== "bearer-access-token" ||
      current?.method !== "bearer-access-token" ||
      current.expiresAt.epochMilliseconds <= now.epochMilliseconds
    ) {
      return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({});
    }
    const replacement = yield* sessions
      .issue({
        method: session.method,
        subject: current.subject,
        scopes: current.scopes,
        client: current.client,
        ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) => new EnvironmentAuth.ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
        ),
      );
    return {
      access_token: replacement.token,
      issued_token_type: AuthAccessTokenType,
      token_type: "Bearer",
      expires_in: Math.max(
        0,
        Math.floor((replacement.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000),
      ),
      scope: encodeOAuthScope(replacement.scopes),
    } satisfies AuthSessionRefreshResult;
  });

export const operatorSessionRefreshHandler = (
  serverAuth: EnvironmentAuth.EnvironmentAuth["Service"],
) =>
  Effect.fn("environment.auth.sessionRefresh")(
    function* () {
      yield* annotateEnvironmentRequest("sessionRefresh");
      const session = yield* EnvironmentAuthenticatedPrincipal;
      if (session.method !== "bearer-access-token") {
        return yield* failEnvironmentOperationForbidden(
          "session_refresh_requires_bearer_access_token",
        );
      }
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(
          HttpServerResponse.setHeaders(response, {
            "cache-control": "no-store",
            pragma: "no-cache",
          }),
        ),
      );
      return yield* serverAuth.refreshSession(session);
    },
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("session_refresh_failed", error),
    ),
  );
