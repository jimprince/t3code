import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { EnvironmentId, WS_METHODS, type ServerConfig } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { emptySnapshot } from "./progress.ts";
import { createDashboardAtoms } from "./store.ts";
const environmentId = EnvironmentId.make("test");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Test",
  httpBaseUrl: "https://test",
  wsBaseUrl: "wss://test",
});
const config = (capable: boolean) =>
  ({ environment: { capabilities: { dashboardSnapshot: capable } } }) as unknown as ServerConfig;

describe("dashboard subscription lifetime", () => {
  it.effect("paints persisted data without trying the new RPC on an older host", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      let calls = 0;
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
          followStream: () => {
            calls++;
            return Stream.never;
          },
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      );
      const stored = { ...emptySnapshot("2026-10-11T10:00:00Z"), revision: 12 };
      const dashboard = createDashboardAtoms(runtime, {
        config: () => Atom.make(config(false)),
        shell: () => Atom.make(null),
        readCached: () => stored,
      });
      const unmount = registry.mount(dashboard.snapshot(environmentId));
      expect(registry.get(dashboard.snapshot(environmentId))).toMatchObject({
        snapshot: stored,
        source: "cached",
        olderServer: true,
        failed: false,
      });
      expect(calls).toBe(0);
      unmount();
      registry.dispose();
    }),
  );
  it.effect("closes the stream after the last mounted view and retains data for reopen", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const value = { ...emptySnapshot("2026-10-11T10:00:00Z"), revision: 7 };
      const client = {
        [WS_METHODS.subscribeDashboard]: () =>
          Stream.concat(Stream.succeed(value), Stream.never).pipe(
            Stream.ensuring(Deferred.succeed(closed, undefined)),
          ),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: (input) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        _,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
          run,
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      );
      const registry = AtomRegistry.make();
      const configAtom = Atom.make(config(true));
      const shellAtom = Atom.make(null);
      const dashboard = createDashboardAtoms(runtime, {
        config: () => configAtom,
        shell: () => shellAtom,
      });
      const atom = dashboard.snapshot(environmentId);
      const unsubscribe = registry.subscribe(
        atom,
        (state) => {
          if (state.snapshot?.revision === 7) Deferred.doneUnsafe(received, Exit.void);
        },
        { immediate: true },
      );
      yield* Deferred.await(received);
      unsubscribe();
      yield* Deferred.await(closed);
      expect(registry.get(atom).snapshot?.revision).toBe(7);
      registry.dispose();
    }),
  );
});
