import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-status-smoke-"));
const state = NodePath.join(temp, "state.json");
const server = NodeChildProcess.spawn(
  process.execPath,
  [NodeURL.fileURLToPath(new URL("./status-env.mjs", import.meta.url)), state],
  { stdio: ["ignore", "pipe", "inherit"] },
);
try {
  await new Promise((resolve, reject) => {
    server.stdout.once("data", resolve);
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
  const command =
    process.argv[2] ?? NodeURL.fileURLToPath(new URL("../../dist/cli.cjs", import.meta.url));
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--max-old-space-size=512", command, "agent", "status"],
    {
      env: { ...process.env, T3_AGENT_STATE_FILE: state },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    stderr = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (stderr += c));
  // The full CI job shares CPU with three other package suites.
  const timeout = setTimeout(() => child.kill(), 180_000);
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  clearTimeout(timeout);
  NodeAssert.equal(code, 0, `${stderr} completedLines=${output.trim().split("\n").length}`);
  NodeAssert.equal(output.trim().split("\n").length, 48);
  NodeAssert.match(output, /worker-47 \[idle\/new\]/);
  console.log(
    JSON.stringify({ command: "agent status", agents: 48, heapCapMiB: 512, status: "pass" }),
  );
} finally {
  server.kill();
  await new Promise((r) => server.once("exit", r));
  await NodeFSP.rm(temp, { recursive: true, force: true });
}
