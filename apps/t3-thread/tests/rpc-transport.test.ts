import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

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
