import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId, WS_METHODS } from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  decodeShellSnapshotItem,
  decodeThreadSnapshotItem,
  WS_SERVER_GET_CONFIG_METHOD,
  WsRpcGroup,
} from "./contracts.js";

const RPC_METHODS = {
  "fork.message.forward.prepare": "fork.message.forward.prepare",
  "fork.message.forward.accept": "fork.message.forward.accept",
  [WS_METHODS.assetsCreateUrl]: WS_METHODS.assetsCreateUrl,
  [WS_METHODS.attachmentsCreateUploadUrl]: WS_METHODS.attachmentsCreateUploadUrl,
  [WS_METHODS.attachmentsDelete]: WS_METHODS.attachmentsDelete,
  "fork.send.accept": "fork.send.accept",
  "fork.send.lookup": "fork.send.lookup",
  "fork.send.inbox": "fork.send.inbox",
  sessionReconcile: "fork.session.reconcile",
  threadIssuesLink: "threadIssues.link",
  threadIssuesUnlink: "threadIssues.unlink",
  automationsList: "automations.list",
  automationsSave: "automations.save",
  automationsRemove: "automations.remove",
  automationsSetEnabled: "automations.setEnabled",
  automationsRun: "automations.run",
  automationsRuns: "automations.runs",
  automationScriptsList: "automationScripts.list",
  automationScriptsSave: "automationScripts.save",
  automationScriptsRemove: "automationScripts.remove",
  automationScriptsRun: "automationScripts.run",

  listNamedAgents: "orchestration.listNamedAgents",
  resolveNamedAgent: "orchestration.resolveNamedAgent",
  handOverNamedAgent: "orchestration.handOverNamedAgent",
  threadMetadataList: "fork.threads.metadata.list",
  threadMetadataUpdate: "fork.threads.metadata.update",
  threadOrderReset: "fork.threads.order.reset",
  projectsMutate: "projects.mutate",
  launchThread: ORCHESTRATION_V2_WS_METHODS.launchThread,
  serverGetConfig: WS_SERVER_GET_CONFIG_METHOD,
  serverGetSettings: WS_METHODS.serverGetSettings,
  giteaSetToken: WS_METHODS.giteaSetToken,
  serverDiscoverSourceControl: WS_METHODS.serverDiscoverSourceControl,
  projectIssuesGet: WS_METHODS.projectIssuesGet,
  dispatchCommand: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  getThreadProjection: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  getArchivedShellSnapshot: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  getTurnDiff: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  getFullThreadDiff: ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  subscribeShell: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  subscribeThread: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  projectRequestsCreate: "projectRequests.create",
  projectRequestsUpdate: "projectRequests.update",
  projectRequestsList: "projectRequests.list",
  projectRequestsDecide: "projectRequests.decide",
  projectRequestsDiscuss: "projectRequests.discuss",
  projectDashboardGet: "projectDashboard.get",
  projectDashboardSetWidgets: "projectDashboard.setWidgets",
  projectDashboardSetTracker: "projectDashboard.setTracker",
  projectDashboardSetHealth: "projectDashboard.setHealth",
  projectLayoutGet: "projectLayout.get",
  projectLayoutApply: "projectLayout.apply",
  projectRoadmapGet: "projectRoadmap.get",
  projectRoadmapMove: "projectRoadmap.move",
  projectRoadmapSaveVersion: "projectRoadmap.saveVersion",
} as const;

const makeT3RpcClient = RpcClient.make(WsRpcGroup);
type RpcProtocolClient =
  typeof makeT3RpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

function wsRpcProtocolLayer(wsUrl: string, opened: Deferred.Deferred<void, Socket.SocketError>) {
  const socketLayer = Layer.effect(
    Socket.Socket,
    Socket.makeWebSocket(wsUrl).pipe(
      Effect.map((socket) => ({
        ...socket,
        reader: socket.reader.pipe(
          Effect.tap(() => Deferred.succeed(opened, undefined)),
          Effect.tapError((error) => Deferred.fail(opened, error)),
        ),
      })),
    ),
  ).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));
  // Reconnection belongs to the pre-RPC boundary below. Never reconnect an in-flight mutation.
  return Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }),
  ).pipe(Layer.provide(socketLayer), Layer.provide(RpcSerialization.layerJson));
}

export class T3RpcClient {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly scope: Scope.Closeable;
  private readonly clientPromise: Promise<RpcProtocolClient>;

  private readonly opened = Deferred.makeUnsafe<void, Socket.SocketError>();

  constructor(wsUrl: string) {
    this.runtime = ManagedRuntime.make(wsRpcProtocolLayer(wsUrl, this.opened));
    this.scope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(Scope.provide(this.scope)(makeT3RpcClient));
  }

  /** Resolves only after the socket reader acquires an open connection, before any RPC write. */
  async awaitOpen(signal?: AbortSignal): Promise<void> {
    await this.clientPromise;
    const result = await this.runtime.runPromiseExit(Deferred.await(this.opened), { signal });
    if (Exit.isFailure(result)) {
      throw Option.getOrElse(
        Cause.findErrorOption(result.cause),
        () => signal?.reason ?? new Error("Socket open interrupted"),
      );
    }
  }

  async request<T>(
    method: keyof typeof RPC_METHODS,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const client = (await this.clientPromise) as unknown as Record<
      string,
      (payload: unknown) => Effect.Effect<T, unknown, never>
    >;
    const operation = Effect.suspend(() => client[RPC_METHODS[method]](input));
    if (method.startsWith("fork.send.") || method.startsWith("fork.message.forward.")) {
      const result = await this.runtime.runPromise(
        Effect.exit(operation.pipe(Effect.timeout("15 seconds"))),
      );
      if (Exit.isSuccess(result)) return result.value;
      throw Option.getOrElse(Cause.findErrorOption(result.cause), () =>
        Object.assign(new Error("TRANSPORT_ERROR"), {
          name: Cause.hasInterrupts(result.cause) ? "AbortError" : "Error",
        }),
      );
    }
    return this.runtime.runPromise(operation, { signal });
  }

  async subscribeShellSnapshot<T>(signal?: AbortSignal): Promise<T> {
    return decodeShellSnapshotItem(
      await this.requestStreamFirst("subscribeShell", {}, signal),
    ) as T;
  }

  async subscribeThreadSnapshot<T>(threadId: string): Promise<T> {
    return decodeThreadSnapshotItem(
      await this.requestStreamFirst("subscribeThread", { threadId }),
    ) as T;
  }

  async waitForThreadEvent(
    threadId: string,
    matches: (item: import("@t3tools/contracts").OrchestrationV2ThreadStreamItem) => boolean,
  ) {
    const client = await this.clientPromise;
    const item = await this.runtime.runPromise(
      Stream.runHead(
        client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId: ThreadId.make(threadId),
        }).pipe(Stream.filter(matches)),
      ),
    );
    return Option.getOrThrow(item);
  }

  async dispose(): Promise<void> {
    try {
      await this.runtime.runPromise(Scope.close(this.scope, Exit.void));
    } finally {
      await this.runtime.dispose();
    }
  }

  private async requestStreamFirst<T>(
    method: "subscribeShell" | "subscribeThread",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const client = (await this.clientPromise) as unknown as Record<
      string,
      (payload: unknown) => Stream.Stream<T, unknown, never>
    >;
    const stream = client[RPC_METHODS[method]](input);
    const item = await this.runtime.runPromise(Stream.runHead(stream), { signal });
    const value = Option.getOrNull(item);
    if (value === null) {
      throw new Error(`No initial snapshot received for '${RPC_METHODS[method]}'.`);
    }
    return value;
  }
}
