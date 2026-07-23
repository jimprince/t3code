import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { resolveStateFile } from "./state.js";

export type WatcherEnsureResult =
  | { status: "already-running"; pid: number }
  | { status: "spawned"; pid: number };

function watcherPidFile(): string {
  return NodePath.join(NodePath.dirname(resolveStateFile()), "watch.pid");
}

function repoRootFromArgv(): string {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot resolve watcher repo root from process.argv[1].");
  }
  return NodePath.resolve(NodePath.dirname(entry), "..");
}

async function readWatcherPid(pidFile: string): Promise<number | null> {
  try {
    const raw = (await NodeFSP.readFile(pidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function claimWatcherLease(): Promise<(() => Promise<void>) | null> {
  const pidFile = watcherPidFile();
  await NodeFSP.mkdir(NodePath.dirname(pidFile), { recursive: true });
  const existingPid = await readWatcherPid(pidFile);
  if (existingPid && existingPid !== process.pid && isProcessRunning(existingPid)) {
    return null;
  }

  if (existingPid && !isProcessRunning(existingPid)) {
    await NodeFSP.unlink(pidFile).catch(() => {});
  }

  await NodeFSP.writeFile(pidFile, `${process.pid}\n`, "utf8");

  return async () => {
    const currentPid = await readWatcherPid(pidFile);
    if (currentPid === process.pid) {
      await NodeFSP.unlink(pidFile).catch(() => {});
    }
  };
}

export async function ensureWatcherProcess(input: {
  env?: string;
  intervalSeconds: number;
  idleExitSeconds: number;
  maxLifetimeSeconds: number;
  deliver: boolean;
}): Promise<WatcherEnsureResult> {
  const pidFile = watcherPidFile();
  await NodeFSP.mkdir(NodePath.dirname(pidFile), { recursive: true });
  const existingPid = await readWatcherPid(pidFile);
  if (existingPid && isProcessRunning(existingPid)) {
    return {
      status: "already-running",
      pid: existingPid,
    };
  }

  if (existingPid && !isProcessRunning(existingPid)) {
    await NodeFSP.unlink(pidFile).catch(() => {});
  }

  const repoRoot = repoRootFromArgv();
  const tsxPath = NodePath.join(repoRoot, "node_modules", ".bin", "tsx");
  const cliEntry = NodePath.join(repoRoot, "src", "cli.ts");
  const args = [
    cliEntry,
    "watch",
    "--interval",
    String(input.intervalSeconds),
    "--idle-exit",
    String(input.idleExitSeconds),
    "--max-lifetime",
    String(input.maxLifetimeSeconds),
  ];

  if (input.env) {
    args.push("--env", input.env);
  }
  if (!input.deliver) {
    args.push("--no-deliver");
  }

  const child = NodeChildProcess.spawn(tsxPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    status: "spawned",
    pid: child.pid ?? -1,
  };
}
