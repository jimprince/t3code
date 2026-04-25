import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { ORCHESTRATION_WS_METHODS } from "./vendor/t3contracts/orchestration.js";
import { WsRpcGroup } from "./vendor/t3contracts/rpc.js";

const RPC_METHODS = {
  dispatchCommand: ORCHESTRATION_WS_METHODS.dispatchCommand,
  getTurnDiff: ORCHESTRATION_WS_METHODS.getTurnDiff,
  getFullThreadDiff: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  subscribeShell: ORCHESTRATION_WS_METHODS.subscribeShell,
  subscribeThread: ORCHESTRATION_WS_METHODS.subscribeThread,
} as const;

const makeT3RpcClient = RpcClient.make(WsRpcGroup);
type RpcProtocolClient =
  typeof makeT3RpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

function wsRpcProtocolLayer(wsUrl: string) {
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols,
      ) as unknown as globalThis.WebSocket,
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl).pipe(Layer.provide(webSocketConstructorLayer))),
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
    method: "dispatchCommand" | "getTurnDiff" | "getFullThreadDiff",
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
    return this.requestStreamFirst<T>("subscribeThread", { threadId });
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
