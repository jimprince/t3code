// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Real-process lock tests use Node IPC/GC and elapsed wall time.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { loadState, updateState } from "./threadRoutingState.ts";

vi.mock("node:child_process", { spy: true });
let directory: string;
let previousStateFile: string | undefined;
const children: NodeChildProcess.ChildProcess[] = [];
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-state-flock-"));
  previousStateFile = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "state.json");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = NodeEvents.once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  vi.restoreAllMocks();
  if (previousStateFile === undefined) delete process.env.T3_AGENT_STATE_FILE;
  else process.env.T3_AGENT_STATE_FILE = previousStateFile;
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

async function holdInChild() {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { updateState } from ${JSON.stringify(new URL("./threadRoutingState.ts", import.meta.url).href)};
     await updateState({ count: 0 }, async state => {
       process.send({ held: true });
       await new Promise(() => { setInterval(() => global.gc(), 100); });
       return { state, result: undefined };
     });`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env } },
  );
  children.push(child);
  const ready = NodeEvents.once(child, "message");
  await Promise.race([
    ready,
    NodeEvents.once(child, "exit").then(([code]) => {
      throw new Error(`Holder exited before locking: ${code}`);
    }),
  ]);
  return child;
}

it("releases a killed holder's lock without cleanup and keeps the same sidecar", async () => {
  const child = await holdInChild();
  const sidecar = `${process.env.T3_AGENT_STATE_FILE}.lock`;
  const inode = (await NodeFSP.stat(sidecar)).ino;
  const exited = NodeEvents.once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await updateState({ count: 0 }, (state) => ({
    state: { count: state.count + 1 },
    result: undefined,
  }));
  expect(await loadState({ count: 0 })).toEqual({ count: 1 });
  expect((await NodeFSP.stat(sidecar)).ino).toBe(inode);
});

it("times out after 10 seconds instead of stealing a live holder's lock", async () => {
  const child = await holdInChild();
  const started = Date.now();
  await expect(updateState({}, (state) => ({ state, result: undefined }))).rejects.toThrow(
    `Last recorded holder: PID ${child.pid}`,
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
  expect(child.exitCode).toBeNull();
}, 15_000);

it("serializes concurrent state mutations without lost updates", async () => {
  await Promise.all(
    Array.from({ length: 12 }, () =>
      updateState({ count: 0 }, (state) => ({
        state: { count: state.count + 1 },
        result: undefined,
      })),
    ),
  );
  expect(await loadState({ count: 0 })).toEqual({ count: 12 });
});

it("releases the persistent lock when a mutator throws", async () => {
  await expect(
    updateState({}, () => {
      throw new Error("mutator failed");
    }),
  ).rejects.toThrow("mutator failed");
  expect(await updateState({}, (state) => ({ state, result: "recovered" }))).toBe("recovered");
});

it("names the Perl requirement if the helper cannot be started", async () => {
  vi.mocked(NodeChildProcess.spawn).mockImplementationOnce(() => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  });
  await expect(updateState({}, (state) => ({ state, result: undefined }))).rejects.toThrow(
    "State locking requires /usr/bin/perl with built-in flock",
  );
});
