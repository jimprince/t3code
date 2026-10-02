import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { T3RpcClient } from "../src/rpc.js";

it("closes an RPC connection during its handshake without an uncaught websocket error", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-rpc-close-"));
  const server = NodeHttp.createServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  const rpcModule = NodeURL.fileURLToPath(new URL("../src/rpc.ts", import.meta.url));
  const script = NodePath.join(directory, "client.mts");
  await NodeFSP.writeFile(
    script,
    `
    import { T3RpcClient } from ${JSON.stringify(rpcModule)};
    const rpc = new T3RpcClient(process.env.TEST_WS_URL);
    const pending = rpc.subscribeShellSnapshot().catch(() => {});
    process.once("message", async () => {
      await rpc.dispose();
      await pending;
      process.disconnect();
    });
  `,
  );
  const child = NodeChildProcess.spawn(
    NodeURL.fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
    [script],
    {
      env: { ...process.env, TEST_WS_URL: `ws://127.0.0.1:${address.port}` },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  server.once("upgrade", () => child.send("dispose"));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(stderr).not.toContain("Unhandled 'error' event");
    expect(code, stderr).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it("opens a fresh real socket after an unsent failure, with a new ticket and no RPC frames", async () => {
  const { createHash } = await import("node:crypto");
  const { openRpcConnection } = await import("../src/openRpc.js");
  const server = NodeHttp.createServer();
  const sockets = new Set<import("node:net").Socket>();
  const tickets: string[] = [];
  const frames: Buffer[] = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    tickets.push(request.url ?? "");
    if (tickets.length === 1) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (data: Buffer) => frames.push(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const clients: T3RpcClient[] = [];
  let issued = 0;
  const delay = vi.fn(async () => {});
  try {
    const rpc = await openRpcConnection(
      { httpBaseUrl: "http://test", wsBaseUrl: "ws://test", bearerToken: "synthetic" },
      {
        resolveUrl: async () => `ws://127.0.0.1:${address.port}/ws?ticket=${++issued}`,
        random: () => 0,
        delay,
        createClient: (url) => {
          const client = new T3RpcClient(url);
          vi.spyOn(client, "dispose");
          clients.push(client);
          return client;
        },
      },
    );
    try {
      expect(delay).toHaveBeenCalledExactlyOnceWith(800, expect.any(AbortSignal));
      expect(clients).toHaveLength(2);
      expect(clients[0]).not.toBe(clients[1]);
      expect(clients[0]!.dispose).toHaveBeenCalledTimes(1);
      expect(clients[1]!.dispose).not.toHaveBeenCalled();
      expect(tickets).toEqual(["/ws?ticket=1", "/ws?ticket=2"]);
      expect(frames).toEqual([]);
    } finally {
      await rpc.dispose();
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
