import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts/orchestration";
import { WS_METHODS } from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { WS_SERVER_GET_CONFIG_METHOD, WsRpcGroup } from "./contracts.js";

const RPC_METHODS = {
  serverGetConfig: WS_SERVER_GET_CONFIG_METHOD,
  dispatchCommand: ORCHESTRATION_WS_METHODS.dispatchCommand,
  getArchivedShellSnapshot: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  getTurnDiff: ORCHESTRATION_WS_METHODS.getTurnDiff,
  getFullThreadDiff: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  subscribeShell: ORCHESTRATION_WS_METHODS.subscribeShell,
  subscribeThread: ORCHESTRATION_WS_METHODS.subscribeThread,
  listNamedAgents: ORCHESTRATION_WS_METHODS.listNamedAgents,
  resolveNamedAgent: ORCHESTRATION_WS_METHODS.resolveNamedAgent,
  handOverNamedAgent: ORCHESTRATION_WS_METHODS.handOverNamedAgent,
  threadIssuesLink: WS_METHODS.threadIssuesLink,
  threadIssuesUnlink: WS_METHODS.threadIssuesUnlink,
  projectRequestsCreate: WS_METHODS.projectRequestsCreate,
  projectRequestsUpdate: WS_METHODS.projectRequestsUpdate,
  projectRequestsList: WS_METHODS.projectRequestsList,
  projectRequestsDecide: WS_METHODS.projectRequestsDecide,
  projectRequestsDiscuss: WS_METHODS.projectRequestsDiscuss,
  projectDashboardGet: WS_METHODS.projectDashboardGet,
  projectDashboardSetWidgets: WS_METHODS.projectDashboardSetWidgets,
  projectDashboardSetTracker: WS_METHODS.projectDashboardSetTracker,
  projectDashboardSetHealth: WS_METHODS.projectDashboardSetHealth,
  projectLayoutGet: WS_METHODS.projectLayoutGet,
  projectLayoutApply: WS_METHODS.projectLayoutApply,
  projectRoadmapGet: WS_METHODS.projectRoadmapGet,
  projectRoadmapMove: WS_METHODS.projectRoadmapMove,
  projectRoadmapSaveVersion: WS_METHODS.projectRoadmapSaveVersion,
  automationsList: WS_METHODS.automationsList,
  automationsSave: WS_METHODS.automationsSave,
  automationsRemove: WS_METHODS.automationsRemove,
  automationsSetEnabled: WS_METHODS.automationsSetEnabled,
  automationsRun: WS_METHODS.automationsRun,
  automationsRuns: WS_METHODS.automationsRuns,
  automationScriptsList: WS_METHODS.automationScriptsList,
  automationScriptsSave: WS_METHODS.automationScriptsSave,
  automationScriptsRemove: WS_METHODS.automationScriptsRemove,
  automationScriptsRun: WS_METHODS.automationScriptsRun,
} as const;

export type AutomationRpcMethod = Extract<
  keyof typeof RPC_METHODS,
  `automations${string}` | `automationScripts${string}`
>;

const makeT3RpcClient = RpcClient.make(WsRpcGroup);
type RpcProtocolClient =
  typeof makeT3RpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

function wsRpcProtocolLayer(wsUrl: string) {
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
}

export class T3RpcClient {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly scope: Scope.Closeable;
  private readonly clientPromise: Promise<RpcProtocolClient>;

  constructor(wsUrl: string) {
    this.runtime = ManagedRuntime.make(wsRpcProtocolLayer(wsUrl));
    this.scope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(Scope.provide(this.scope)(makeT3RpcClient));
  }

  async request<T>(
    method:
      | "serverGetConfig"
      | "dispatchCommand"
      | "getTurnDiff"
      | "getFullThreadDiff"
      | "getArchivedShellSnapshot"
      | "listNamedAgents"
      | "resolveNamedAgent"
      | "handOverNamedAgent"
      | "threadIssuesLink"
      | "threadIssuesUnlink"
      | "projectRequestsCreate"
      | "projectRequestsUpdate"
      | "projectRequestsList"
      | "projectRequestsDecide"
      | "projectRequestsDiscuss"
      | "projectDashboardGet"
      | "projectDashboardSetWidgets"
      | "projectDashboardSetTracker"
      | "projectDashboardSetHealth"
      | "projectLayoutGet"
      | "projectLayoutApply"
      | "projectRoadmapGet"
      | "projectRoadmapMove"
      | "projectRoadmapSaveVersion"
      | AutomationRpcMethod,
    input: unknown,
  ): Promise<T> {
    const client = (await this.clientPromise) as unknown as Record<
      string,
      (payload: unknown) => Effect.Effect<T, unknown, never>
    >;
    return this.runtime.runPromise(Effect.suspend(() => client[RPC_METHODS[method]](input)));
  }

  async subscribeShellSnapshot<T>(): Promise<T> {
    return this.requestStreamFirst<T>("subscribeShell", {});
  }

  async subscribeThreadSnapshot<T>(threadId: string): Promise<T> {
    return this.requestStreamFirst<T>("subscribeThread", { threadId, reasoningMessages: true });
  }

  async dispose(): Promise<void> {
    await this.runtime.runPromise(Scope.close(this.scope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }

  private async requestStreamFirst<T>(
    method: "subscribeShell" | "subscribeThread",
    input: unknown,
  ): Promise<T> {
    const client = (await this.clientPromise) as unknown as Record<
      string,
      (payload: unknown) => Stream.Stream<T, unknown, never>
    >;
    const stream = client[RPC_METHODS[method]](input);
    const item = await this.runtime.runPromise(Stream.runHead(stream));
    const value = Option.getOrNull(item);
    if (value === null) {
      throw new Error(`No initial snapshot received for '${RPC_METHODS[method]}'.`);
    }
    return value;
  }
}
