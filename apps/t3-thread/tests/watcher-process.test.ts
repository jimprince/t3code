import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearOwnWatcherPid,
  ensureWatcherRunning,
  isWatcherRunning,
  readWatcherPid,
  watcherPidFile,
  writeWatcherPid,
} from "../src/watcher-process.js";

let tempDir: string;
let previousStateFile: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "t3-thread-watcher-test-"));
  previousStateFile = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = path.join(tempDir, "state.json");
});

afterEach(async () => {
  if (previousStateFile === undefined) {
    delete process.env.T3_AGENT_STATE_FILE;
  } else {
    process.env.T3_AGENT_STATE_FILE = previousStateFile;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("watcher pidfile / singleton guard", () => {
  it("places the pidfile next to the state file", () => {
    expect(watcherPidFile()).toBe(path.join(tempDir, "watch.pid"));
  });

  it("returns null pid and not-running when no pidfile exists", async () => {
    expect(await readWatcherPid()).toBeNull();
    expect(await isWatcherRunning()).toBe(false);
  });

  it("ignores a pidfile that points at the current process (self is not 'another' watcher)", async () => {
    await writeWatcherPid();
    expect(await readWatcherPid()).toBe(process.pid);
    expect(await isWatcherRunning()).toBe(false);
  });

  it("treats a stale/dead pid as not running and does not clear a foreign pidfile", async () => {
    await writeFile(watcherPidFile(), "999999999\n", "utf8");
    expect(await isWatcherRunning()).toBe(false);
    await clearOwnWatcherPid(); // not our pid → must leave it
    expect((await readFile(watcherPidFile(), "utf8")).trim()).toBe("999999999");
  });

  it("does NOT spawn a second watcher when a live one already owns the pidfile", async () => {
    // A long-lived child stands in for a running watcher.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await writeFile(watcherPidFile(), `${child.pid}\n`, "utf8");
      expect(await isWatcherRunning()).toBe(true);
      // Singleton: ensureWatcherRunning must be a no-op (returns false, spawns nothing).
      expect(await ensureWatcherRunning()).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
