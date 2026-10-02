import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  claimWatcherLease,
  ensureWatcherProcess,
  isProcessRunning,
  readProcessIdentity,
  parseDarwinBootId,
} from "../src/watcher-process.js";

async function withTempStateDir(test: (stateFile: string) => Promise<void>): Promise<void> {
  const tempDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-thread-watcher-process-test-"),
  );
  const stateFile = NodePath.join(tempDir, "state.json");
  const previousStateFile = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = stateFile;

  try {
    await test(stateFile);
  } finally {
    if (previousStateFile === undefined) {
      delete process.env.T3_AGENT_STATE_FILE;
    } else {
      process.env.T3_AGENT_STATE_FILE = previousStateFile;
    }
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

describe("watcher process helpers", () => {
  it("uses Darwin boot seconds despite drifting microseconds and local date text", () => {
    expect(parseDarwinBootId("{ sec = 1790904510, usec = 856511 } Thu Oct 1 19:28:30 2026")).toBe(
      "1790904510",
    );
    expect(parseDarwinBootId("{ sec = 1790904510, usec = 991111 } Fri Oct 2 01:28:30 2026")).toBe(
      "1790904510",
    );
    expect(() => parseDarwinBootId("invalid")).toThrow();
  });

  it("retains lifetime exclusion when its lease is removed", async () => {
    await withTempStateDir(async (stateFile) => {
      const release = await claimWatcherLease();
      const pidFile = NodePath.join(NodePath.dirname(stateFile), "watch.pid");
      await NodeFSP.unlink(pidFile);
      let competingRelease: (() => Promise<void>) | null = null;
      try {
        competingRelease = await claimWatcherLease();
        expect(competingRelease).toBeNull();
      } finally {
        await competingRelease?.();
        await release?.();
      }
      const replacement = await claimWatcherLease();
      expect(replacement).not.toBeNull();
      await replacement?.();
    });
  });

  it("keeps a genuine watcher singleton and releases its identity lease", async () => {
    await withTempStateDir(async (stateFile) => {
      const release = await claimWatcherLease();
      expect(release).not.toBeNull();
      const pidFile = NodePath.join(NodePath.dirname(stateFile), "watch.pid");
      expect(JSON.parse(await NodeFSP.readFile(pidFile, "utf8"))).toEqual(
        await readProcessIdentity(process.pid),
      );
      await expect(claimWatcherLease()).resolves.toBeNull();
      await expect(
        ensureWatcherProcess({
          intervalSeconds: 5,
          idleExitSeconds: 900,
          maxLifetimeSeconds: 3600,
          deliver: true,
        }),
      ).resolves.toEqual({ status: "already-running", pid: process.pid });
      await release?.();
      const nextRelease = await claimWatcherLease();
      expect(nextRelease).not.toBeNull();
      await nextRelease?.();
    });
  });

  it.each(["bootId", "startTime"] as const)(
    "rejects a reused live PID with different %s without killing it",
    async (field) => {
      await withTempStateDir(async (stateFile) => {
        const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
          stdio: "pipe",
        });
        await NodeEvents.once(child, "spawn");
        const pid = child.pid!;
        try {
          const identity = await readProcessIdentity(pid);
          expect(identity).not.toBeNull();
          const pidFile = NodePath.join(NodePath.dirname(stateFile), "watch.pid");
          await NodeFSP.writeFile(pidFile, JSON.stringify({ ...identity, [field]: "stale" }));
          const release = await claimWatcherLease();
          expect(release).not.toBeNull();
          expect(isProcessRunning(pid)).toBe(true);
          expect(JSON.parse(await NodeFSP.readFile(pidFile, "utf8")).pid).toBe(process.pid);
          await release?.();
        } finally {
          const exited = NodeEvents.once(child, "exit");
          child.kill();
          await exited;
        }
      });
    },
  );

  it("replaces a legacy lease only when its PID is gone", async () => {
    await withTempStateDir(async (stateFile) => {
      const pidFile = NodePath.join(NodePath.dirname(stateFile), "watch.pid");
      await NodeFSP.writeFile(pidFile, "999999\n", "utf8");
      const release = await claimWatcherLease();
      expect(release).not.toBeNull();
      await release?.();
      await NodeFSP.writeFile(pidFile, `${process.pid}\n`, "utf8");
      await expect(claimWatcherLease()).rejects.toThrow("Cannot verify live legacy watcher PID");
      expect(await NodeFSP.readFile(pidFile, "utf8")).toBe(`${process.pid}\n`);
    });
  });

  it("does not remove a replacement lease when the old owner releases", async () => {
    await withTempStateDir(async (stateFile) => {
      const release = await claimWatcherLease();
      const pidFile = NodePath.join(NodePath.dirname(stateFile), "watch.pid");
      const replacement = { pid: process.pid, bootId: "replacement", startTime: "replacement" };
      await NodeFSP.writeFile(pidFile, JSON.stringify(replacement));
      await release?.();
      expect(JSON.parse(await NodeFSP.readFile(pidFile, "utf8"))).toEqual(replacement);
    });
  });
});
