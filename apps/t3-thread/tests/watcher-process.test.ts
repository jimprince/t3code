import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { claimWatcherLease } from "../src/watcher-process.js";

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
  it("claims and releases the singleton watcher lease", async () => {
    await withTempStateDir(async (stateFile) => {
      const release = await claimWatcherLease();
      expect(release).not.toBeNull();

      const pidFile = NodePath.join(NodePath.dirname(stateFile), "watch.pid");
      await NodeFSP.writeFile(pidFile, `${process.pid + 100000}\n`, "utf8");
      await expect(claimWatcherLease()).resolves.not.toBeNull();

      await release?.();
      const nextRelease = await claimWatcherLease();
      expect(nextRelease).not.toBeNull();
      await nextRelease?.();
    });
  });

  it("replaces a stale watcher pidfile", async () => {
    await withTempStateDir(async (stateFile) => {
      const pidFile = NodePath.join(NodePath.dirname(stateFile), "watch.pid");
      await NodeFSP.writeFile(pidFile, "999999\n", "utf8");

      const release = await claimWatcherLease();
      expect(release).not.toBeNull();
      await release?.();
    });
  });
});
