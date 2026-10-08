import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import { HttpClient, HttpClientResponse, HttpClientError } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { createEnvironmentSessionAtoms, sessionStateGrants } from "./session.ts";
import { createCommandPermissions } from "./commandPermissions.ts";

const env = EnvironmentId.make("session-test");
const target = new PrimaryConnectionTarget({
  environmentId: env,
  label: "Test",
  httpBaseUrl: "https://test.invalid",
  wsBaseUrl: "wss://test.invalid",
});
const granted: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationOperateScope],
};

afterEach(() => vi.useRealTimers());

const harness = Effect.gen(function* () {
  const prepared = yield* SubscriptionRef.make(
    Option.some<PreparedConnection>({
      environmentId: env,
      label: "Test",
      target,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
    }),
  );
  const supervisor = { prepared } as unknown as EnvironmentSupervisor["Service"];
  const replies: Array<Response | "timeout" | "network"> = [];
  let calls = 0;
  const client = HttpClient.make((request) => {
    calls++;
    const reply = replies.shift();
    if (reply === "timeout") return Effect.never;
    if (reply === "network")
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "network offline" }),
        }),
      );
    if (!reply) return Effect.die("Missing test response");
    return Effect.succeed(HttpClientResponse.fromWeb(request, reply));
  });
  const environments = {
    followStream: (
      _id: EnvironmentId,
      stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
    ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as unknown as EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.mock(RemoteEnvironmentAuthorization)({
        authorizeDpopHttp: () =>
          Effect.fail(
            new ConnectionBlockedError({
              reason: "authentication",
              detail: "Cloud sign-in was revoked.",
            }),
          ),
      }),
    ),
  );
  const sessions = createEnvironmentSessionAtoms(runtime);
  const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
  const registry = AtomRegistry.make();
  const atom = sessions.sessionStateAtom(env);
  const wait = (predicate: (value: Atom.Type<typeof atom>) => boolean) =>
    new Promise<void>((resolve) => {
      if (predicate(registry.get(atom))) return resolve();
      const unsubscribe = registry.subscribe(atom, (value) => {
        if (predicate(value)) {
          unsubscribe();
          resolve();
        }
      });
    });
  return { replies, registry, atom, permissions, wait, prepared, calls: () => calls };
});

it.live(
  "keeps grants after a timed-out check, retries with backoff, drops a 401 and recovers without remount",
  () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = yield* harness;
      h.replies.push(Response.json(granted));
      const unmount = h.registry.mount(h.atom);
      try {
        yield* Effect.promise(() => h.wait((value) => value._tag === "Success"));
        const permission = h.permissions.permissionAtom(env);
        expect(h.registry.get(permission)).toBe(true);
        h.replies.push("timeout");
        h.registry.refresh(h.atom);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
        yield* Effect.promise(() => h.wait((value) => value._tag === "Failure" && !value.waiting));
        expect(sessionStateGrants(h.registry.get(h.atom))).toEqual(granted);
        expect(h.registry.get(permission)).toBe(true);
        yield* h.permissions.authorize(h.registry, env);
        h.replies.push("network");
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000));
        yield* Effect.promise(() => h.wait((value) => value._tag === "Failure" && !value.waiting));
        expect(h.calls()).toBe(3);
        expect(h.registry.get(permission)).toBe(true);
        h.replies.push(
          Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "rejected",
            },
            { status: 401 },
          ),
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_999));
        expect(h.calls()).toBe(3);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
        yield* Effect.promise(() => h.wait((value) => value._tag === "Failure" && !value.waiting));
        expect(h.calls()).toBe(4);
        expect(h.registry.get(permission)).toBe(false);
        expect(sessionStateGrants(h.registry.get(h.atom))).toBeNull();
        const denied = yield* h.permissions.authorize(h.registry, env).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
        h.replies.push("network");
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(4_000));
        expect(h.calls()).toBe(5);
        expect(h.registry.get(permission)).toBe(false);
        h.replies.push(Response.json(granted));
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(8_000));
        yield* Effect.promise(() => h.wait((value) => value._tag === "Success" && !value.waiting));
        expect(h.calls()).toBe(6);
        expect(h.registry.get(permission)).toBe(true);
        yield* h.permissions.authorize(h.registry, env);
      } finally {
        unmount();
        h.registry.dispose();
      }
    }),
);

it.live("cancels failed-check retries when the last subscriber unmounts", () =>
  Effect.gen(function* () {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = yield* harness;
    h.replies.push("network");
    const unmount = h.registry.mount(h.atom);
    try {
      yield* Effect.promise(() => h.wait((value) => value._tag === "Failure" && !value.waiting));
      expect(h.calls()).toBe(1);
      const removed = new Promise<void>((resolve) => {
        h.registry.onNodeRemoved = (node) => {
          if (node.atom === h.atom) resolve();
        };
      });
      unmount();
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      yield* Effect.promise(() => removed);
      const callsAfterUnmount = h.calls();
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_000));
      expect(h.calls()).toBe(callsAfterUnmount);
    } finally {
      h.registry.dispose();
    }
  }),
);

it.live("drops previous grants when relay authorization rejects a revoked cloud sign-in", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.replies.push(Response.json(granted));
    const unmount = h.registry.mount(h.atom);
    try {
      yield* Effect.promise(() => h.wait((value) => value._tag === "Success"));
      const permission = h.permissions.permissionAtom(env);
      expect(h.registry.get(permission)).toBe(true);
      const previous = Option.getOrThrow(yield* SubscriptionRef.get(h.prepared));
      yield* SubscriptionRef.set(
        h.prepared,
        Option.some({
          ...previous,
          httpAuthorization: { _tag: "Dpop", accessToken: "revoked", expiresAtEpochMs: 0 },
        }),
      );
      yield* Effect.promise(() => h.wait((value) => value._tag === "Failure" && !value.waiting));
      expect(h.calls()).toBe(1);
      expect(h.registry.get(permission)).toBe(false);
      expect(sessionStateGrants(h.registry.get(h.atom))).toBeNull();
      expect((yield* h.permissions.authorize(h.registry, env).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    } finally {
      unmount();
      h.registry.dispose();
    }
  }),
);
