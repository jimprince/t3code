import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-threads-smoke-"));
const state = NodePath.join(temp, "state.json");
const server = NodeChildProcess.spawn(
  process.execPath,
  [NodeURL.fileURLToPath(new URL("./status-env.mjs", import.meta.url)), state, "threads"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
try {
  await new Promise((resolve, reject) => {
    server.stdout.once("data", resolve);
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
  const before = await NodeFSP.readFile(state);
  const metadata = await NodeFSP.stat(state);
  const command =
    process.argv[2] ?? NodeURL.fileURLToPath(new URL("../../dist/cli.cjs", import.meta.url));
  const invoke = async (...extra) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--max-old-space-size=512", command, "threads", "--env", "fixture", "--json", ...extra],
      { env: { ...process.env, T3_AGENT_STATE_FILE: state }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      stderr = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timeout = setTimeout(() => child.kill(), 40_000);
    const code = await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    clearTimeout(timeout);
    NodeAssert.equal(code, 0, stderr);
    return JSON.parse(output);
  };
  const rows = await invoke();
  NodeAssert.equal(rows.length, 4);
  NodeAssert.equal(rows[3].archived, true);
  NodeAssert.equal(rows[0].queuedCount, 2);
  NodeAssert.equal(rows[0].heldCount, 1);
  NodeAssert.equal(rows[0].oldestQueuedAt, "2026-10-05T00:00:00.000Z");
  NodeAssert.equal(rows[0].activeRunId, "active");
  NodeAssert.equal(rows[0].latestRunStartedAt, "2026-10-05T00:00:00.000Z");
  NodeAssert.equal(rows[1].queuedCount, null);
  NodeAssert.match(rows[1].queueError, /timed out/);
  NodeAssert.equal(rows[2].queuedCount, 0);
  const fullMetrics = JSON.parse(await NodeFSP.readFile(`${state}.metrics`, "utf8"));
  NodeAssert.equal(fullMetrics.connections, 1);
  NodeAssert.equal(fullMetrics.shellReads, 1);
  NodeAssert.equal(fullMetrics.queueReads.length, 4);
  NodeAssert.equal(fullMetrics.archiveReads, 1);
  NodeAssert.equal(fullMetrics.refreshes, 0);
  const active = await invoke("--active-only");
  NodeAssert.equal(active[0].queuedCount, 2);
  NodeAssert.equal(active[1].queuedCount, null);
  const metrics = JSON.parse(await NodeFSP.readFile(`${state}.metrics`, "utf8"));
  NodeAssert.equal(metrics.queueReads.length, 5);
  NodeAssert.equal(metrics.connections, 2);
  NodeAssert.deepEqual(await NodeFSP.readFile(state), before);
  NodeAssert.equal((await NodeFSP.stat(state)).mtimeMs, metadata.mtimeMs);
  await NodeAssert.rejects(NodeFSP.stat(`${state}.lock`), { code: "ENOENT" });
  console.log(
    JSON.stringify({ command: "threads --json", heapCapMiB: 512, status: "pass", rows, metrics }),
  );
} finally {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await exited;
  await NodeFSP.rm(temp, { recursive: true, force: true });
}
