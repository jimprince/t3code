import { expect, it } from "vite-plus/test";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";
import { DateTime, Schema } from "effect";
import {
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadStreamItem,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { T3RpcClient } from "../src/rpc.js";
import { RemoteEnvironmentClient } from "../src/client.js";
import { buildAgentOverview } from "../src/monitor.js";
import { descriptorFixture } from "./descriptor-fixture.js";
import type { SavedEnvironment, SavedAgent } from "../src/types.js";
import { v2Projection } from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { buildBoundedThreadStreamSnapshot } from "../../server/src/orchestration-v2/ThreadStream.ts";
import { shouldUseBoundedThreadSnapshot } from "../../server/src/ws.ts";

const encode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

it("findThread uses the real RPC bounded path for 10,000 items and preserves operator metadata and full-history reads", async () => {
  const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
  const items: OrchestrationV2TurnItem[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: TurnItemId.make(`command-${index}`),
    type: "command_execution",
    threadId: v2Projection.thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "completed",
    title: "Tool",
    input: "echo fixture",
    output: "x".repeat(1024),
    exitCode: 0,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  }));
  const projection = {
    ...v2Projection,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
  };
  const summary = {
    messageCount: 250,
    proposedPlanCount: 7,
    latestAssistantMessage: {
      id: MessageId.make("old-reply"),
      threadId: projection.thread.id,
      runId: null,
      nodeId: null,
      role: "assistant" as const,
      text: "Previous completed response",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: "agent" as const,
      creationSource: "server" as const,
    },
  };
  const requests: Array<{ acceptBoundedSnapshot?: boolean; includeOperatorSummary?: boolean }> = [];
  const server = NodeHttp.createServer();
  const sockets = new Set<NodeStream.Duplex>();
  const send = (socket: NodeStream.Duplex, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(data.length < 126 ? 2 : data.length < 65536 ? 4 : 10);
    header[0] = 0x81;
    if (header.length === 2) header[1] = data.length;
    else if (header.length === 4) {
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    socket.write(Buffer.concat([header, data]));
  };
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const accept = NodeCrypto.createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        let length = pending[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (pending[1]! & 128) !== 0;
        if (pending.length < offset + (masked ? 4 : 0) + length) return;
        const mask = pending.subarray(offset, offset + 4);
        offset += masked ? 4 : 0;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        const opcode = pending[0]! & 15;
        pending = pending.subarray(offset + length);
        if (opcode === 8) {
          socket.end();
          return;
        }
        if (opcode !== 1) continue;
        if (masked)
          for (let index = 0; index < payload.length; index++)
            payload[index] = payload[index]! ^ mask[index % 4]!;
        const message = JSON.parse(payload.toString());
        if (message._tag === "Ping") {
          send(socket, { _tag: "Pong" });
          continue;
        }
        if (message._tag !== "Request") continue;
        expect(message.tag).toBe(ORCHESTRATION_V2_WS_METHODS.subscribeThread);
        requests.push(message.payload);
        const snapshot = shouldUseBoundedThreadSnapshot(message.payload)
          ? buildBoundedThreadStreamSnapshot({
              snapshotSequence: 5,
              projection,
              operatorSummary: message.payload.includeOperatorSummary ? summary : undefined,
            })
          : { kind: "snapshot" as const, snapshotSequence: 5, projection };
        send(socket, { _tag: "Chunk", requestId: message.id, values: [encode(snapshot)] });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing port");
  const environment: SavedEnvironment = {
    name: "test",
    environmentId: "test",
    label: "Test",
    serverVersion: "test",
    httpBaseUrl: "http://127.0.0.1",
    wsBaseUrl: `ws://127.0.0.1:${address.port}`,
    bearerToken: "fixture",
    expiresAt: "2099-01-01T00:00:00Z",
    pairedAt: "2026-10-01T00:00:00Z",
  };
  const client = new RemoteEnvironmentClient(environment, {
    rpcFactory: (url) => new T3RpcClient(url),
    descriptorFactory: descriptorFixture(environment),
  });
  try {
    const thread = await client.findThread(String(projection.thread.id), { nesting: false });
    expect(requests[0]).toMatchObject({
      acceptBoundedSnapshot: true,
      includeOperatorSummary: true,
    });
    expect(thread.projection!.turnItems.length).toBeLessThan(10_000);
    expect(thread.operatorSummary).toEqual(summary);
    const overview = buildAgentOverview(
      {
        name: "fixture",
        threadId: thread.id,
        environment: "test",
        title: thread.title,
      } as SavedAgent,
      thread,
    );
    expect(overview.latestAssistantMessageId).toBe(summary.latestAssistantMessage?.id ?? null);
    const detail = await client.getThreadDetail(thread.id);
    expect(requests[1]?.acceptBoundedSnapshot).toBe(false);
    expect(detail.projection!.turnItems).toHaveLength(10_000);
    const rpc = new T3RpcClient(environment.wsBaseUrl);
    try {
      await rpc.waitForThreadEvent(thread.id, (item) => item.kind === "snapshot");
      expect(requests[2]?.acceptBoundedSnapshot).toBe(true);
    } finally {
      await rpc.dispose();
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
