import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  ProjectDashboardError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type ServerConfig,
} from "@t3tools/contracts";
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
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { emptySnapshot } from "./progress.ts";
import { createDashboardAtoms } from "./store.ts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
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
      let shellReads = 0;
      const dashboard = createDashboardAtoms(runtime, {
        config: () => configAtom,
        shell: () => {
          shellReads++;
          return shellAtom;
        },
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
      expect(shellReads).toBe(0);
      unsubscribe();
      yield* Deferred.await(closed);
      expect(registry.get(atom).snapshot?.revision).toBe(7);
      registry.dispose();
    }),
  );
});

it.effect("an older VM publishes a live dashboard while its tracker RPC is still pending", () =>
  Effect.gen(function* () {
    const root = ThreadId.make("vm-head");
    const received = yield* Deferred.make<void>();
    const trackerStarted = yield* Deferred.make<void>();
    let trackerReads = 0;
    let metadataReads = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = {
      "fork.threads.metadata.list": () =>
        Effect.sync(() => {
          metadataReads++;
          return [{ threadId: root, parentThreadId: null, subproject: "on" }];
        }),
      [WS_METHODS.projectDashboardGet]: () =>
        Effect.fail(new ProjectDashboardError({ message: "Unsupported" })),
      [WS_METHODS.projectIssuesList]: () =>
        Effect.sync(() => {
          trackerReads++;
        }).pipe(
          Effect.andThen(Deferred.succeed(trackerStarted, undefined)),
          Effect.andThen(Effect.never),
        ),
      [WS_METHODS.projectRoadmapGet]: () =>
        Effect.succeed({ tracker: null, versions: [], items: [] }),
      [WS_METHODS.projectRequestsPendingAsks]: () => Effect.succeed({ asks: [] }),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const state: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
      desired: true,
      network: "online",
      attempt: 1,
      generation: 1,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(state),
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
    const configAtom = Atom.make({
      environment: {
        capabilities: { dashboardSnapshot: false },
        serverVersion: "fork.12",
        label: "VM",
      },
    } as unknown as ServerConfig);
    const shellAtom = Atom.make({
      schemaVersion: 1 as const,
      snapshotSequence: 1,
      projects: [],
      archivedThreads: [],
      threads: [{ ...v2ThreadShell, id: root, title: "T3 Orchestrator" }],
    });
    const dashboard = createDashboardAtoms(runtime, {
      config: () => configAtom,
      shell: () => shellAtom,
    });
    const atom = dashboard.snapshot(environmentId);
    const unsubscribe = registry.subscribe(
      atom,
      (value) => {
        if (value.snapshot?.revision === 1) Deferred.doneUnsafe(received, Exit.void);
      },
      { immediate: true },
    );
    try {
      yield* Deferred.await(received);
      yield* Deferred.await(trackerStarted);
      const value = registry.get(atom);
      expect(value).toMatchObject({
        refreshing: true,
        failed: false,
        olderServer: true,
        source: "live",
      });
      expect(value.snapshot?.projects[0]?.title).toBe("T3 Orchestrator");
      expect(value.snapshot?.releases[0]?.installedVersion).toBe("fork.12");
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 1));
      expect(trackerReads).toBe(1);
      expect(metadataReads).toBe(1);
    } finally {
      unsubscribe();
      registry.dispose();
      vi.useRealTimers();
    }
  }),
);
