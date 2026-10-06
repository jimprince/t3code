import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProcessLaunchHealth,
  WS_METHODS,
  type ResourceTelemetrySnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

it.effect(
  "keeps native launch health scoped to the selected remote environment and tolerates an older server",
  () =>
    Effect.gen(function* () {
      const local = EnvironmentId.make("local");
      const remote = EnvironmentId.make("remote");
      const oldServer = EnvironmentId.make("old-server");
      const config = {} as ServerConfig;
      const supervisors = new Map<
        EnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor["Service"]
      >();
      const calls: Array<EnvironmentId> = [];
      for (const id of [local, remote, oldServer]) {
        const health =
          id === oldServer
            ? {}
            : {
                processLaunch: Schema.decodeUnknownSync(ProcessLaunchHealth)({
                  sampledAtUnixMs: 1000,
                  attemptsPerMinute: id === remote ? 42 : 1,
                  failuresPerMinute: id === remote ? 3 : 0,
                  syspolicyd: null,
                  warnings: [id],
                }),
              };
        const client = {
          [WS_METHODS.subscribeResourceTelemetry]: () => {
            calls.push(id);
            return Stream.concat(
              Stream.make({ health } as unknown as ResourceTelemetrySnapshot),
              Stream.never,
            );
          },
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          initialConfig: Effect.succeed(config),
          subscribeServerConfig: () => Stream.never,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        supervisors.set(
          id,
          EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId: id,
              label: id,
              httpBaseUrl: `https://${id}.example.test`,
              wsBaseUrl: `wss://${id}.example.test`,
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const environments = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
        followStream: (id, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
          Layer.succeed(Persistence.EnvironmentCacheStore, cache),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(config),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const read = (id: EnvironmentId) =>
        AtomRegistry.toStream(
          registry,
          atoms.resourceTelemetry({ environmentId: id, input: {} }),
        ).pipe(
          Stream.filter(AsyncResult.isSuccess),
          Stream.map((result) => result.value),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
      const remoteSnapshot = yield* read(remote);
      expect(remoteSnapshot.health.processLaunch?.attemptsPerMinute).toBe(42);
      expect(remoteSnapshot.health.processLaunch?.warnings).toEqual([remote]);
      const localSnapshot = yield* read(local);
      expect(localSnapshot.health.processLaunch?.attemptsPerMinute).toBe(1);
      expect((yield* read(oldServer)).health.processLaunch).toBeUndefined();
      expect(calls).toEqual([remote, local, oldServer]);
    }).pipe(Effect.scoped),
);
