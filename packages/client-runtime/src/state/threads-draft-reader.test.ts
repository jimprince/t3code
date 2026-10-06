import {
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadStateAtoms } from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const REPLY_ID = TurnItemId.make("assistant-reply");

const reply: OrchestrationV2ProjectedTurnItem = {
  position: 0,
  visibility: "local",
  sourceThreadId: THREAD_ID,
  sourceItemId: REPLY_ID,
  item: {
    id: REPLY_ID,
    type: "assistant_message",
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: v2Projection.thread.createdAt,
    completedAt: v2Projection.thread.createdAt,
    updatedAt: v2Projection.thread.createdAt,
    messageId: MessageId.make("assistant-reply-message"),
    text: "hello back",
    streaming: false,
  },
};
const withReply: OrchestrationV2ThreadProjection = { ...v2Projection, visibleTurnItems: [reply] };

// The server answers "not found" for a thread until it has been created.
const makeHarness = Effect.fn("TestDraftReader.makeHarness")(function* () {
  const subscriptions = yield* Queue.unbounded<Queue.Queue<OrchestrationV2ThreadStreamItem>>();
  let created = false;
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          yield* Queue.offer(subscriptions, events);
          return Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: true,
      threadSnapshotPagination: true,
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected environment registration"),
    registerPlatform: () => Effect.die("Unexpected environment registration"),
    reconcilePlatform: () => Effect.die("Unexpected environment reconciliation"),
    remove: () => Effect.die("Unexpected environment removal"),
    removeRoute: () => Effect.die("Unexpected route removal"),
    reorderRoutes: () => Effect.die("Unexpected route reorder"),
    removeRelayEnvironments: () => Effect.die("Unexpected environment removal"),
    retryNow: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected environment toggle"),
    setCompatibility: () => Effect.die("Unexpected compatibility update"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        Persistence.EnvironmentCacheStore,
        Persistence.EnvironmentCacheStore.of({
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
        }),
      ),
      Layer.succeed(
        ThreadSnapshotLoader.ThreadSnapshotLoader,
        ThreadSnapshotLoader.ThreadSnapshotLoader.of({
          load: () =>
            Effect.sync(() => {
              return created
                ? {
                    _tag: "present" as const,
                    snapshot: { snapshotSequence: 1, projection: v2Projection },
                  }
                : { _tag: "missing" as const };
            }),
        }),
      ),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(
    createEnvironmentThreadStateAtoms(runtime).stateAtom,
  );
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (value) => Effect.sync(() => value.dispose()),
  );
  return {
    registry,
    details,
    subscriptions,
    ref: { environmentId: TARGET.environmentId, threadId: THREAD_ID },
    createThread: () => {
      created = true;
    },
  };
});

const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow);

describe("detail reads of a draft's reserved thread id", () => {
  // OrchestratorFocus reads the projection for every open timeline, drafts
  // included. It waits for the thread shell, as ChatView does, so the reply
  // streamed after the first send still reaches the ChatView that stays
  // mounted through the draft-to-thread route swap.
  it.effect("a focus read gated on the shell leaves the thread's detail stream to open later", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const shellExists = Atom.make(false);
      const focusRead = Atom.make((get) =>
        get(shellExists) ? get(h.details.threadAtom(h.ref)) : null,
      );
      h.registry.mount(focusRead);
      yield* settle;

      h.createThread();
      h.registry.set(shellExists, true);
      h.registry.mount(h.details.visibleTurnItemsAtom(h.ref));
      yield* settle;
      expect(yield* Queue.size(h.subscriptions)).toBe(1);

      const events = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshotSequence: 2,
        projection: withReply,
      });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* settle;
      expect(h.registry.get(h.details.statusAtom(h.ref))).toBe("live");
      expect(h.registry.get(h.details.visibleTurnItemsAtom(h.ref))).toEqual([reply]);
    }),
  );
});
