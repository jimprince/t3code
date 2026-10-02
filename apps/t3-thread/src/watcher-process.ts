import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { THREAD_ROUTING_LOCK_HELPER } from "@t3tools/shared/threadRoutingState";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { resolveStateFile, updateState } from "./state.js";

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

interface WatcherLease {
  pid: number;
  bootId: string;
  startTime: string;
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export function parseDarwinBootId(raw: string): string {
  const seconds = /\bsec\s*=\s*(\d+)\b/.exec(raw)?.[1];
  if (!seconds) throw new Error("Invalid Darwin kern.boottime output.");
  return seconds;
}

/** Process identity survives PID reuse, but never a reboot or process replacement. */
export async function readProcessIdentity(pid: number): Promise<WatcherLease | null> {
  const platform = Effect.runSync(HostProcess.Platform);
  if (platform === "linux") {
    const bootId = (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    let stat: string;
    try {
      stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // comm is parenthesized and may itself contain spaces and closing parentheses.
    const startTime = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    if (!startTime || !/^\d+$/.test(startTime)) throw new Error(`Invalid process stat for ${pid}.`);
    return { pid, bootId, startTime };
  }
  if (platform === "darwin") {
    const bootId = parseDarwinBootId((await execFile("sysctl", ["-n", "kern.boottime"])).stdout);
    let startTime: string;
    try {
      startTime = (await execFile("ps", ["-p", String(pid), "-o", "lstart="])).stdout.trim();
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return null;
      throw error;
    }
    return startTime ? { pid, bootId, startTime } : null;
  }
  throw new Error(`Watcher process identity is unsupported on ${platform}.`);
}

async function readWatcherLease(pidFile: string): Promise<WatcherLease | number | null> {
  let raw: string;
  try {
    raw = (await NodeFSP.readFile(pidFile, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // A legacy lease can only be reclaimed once its PID is provably gone.
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  const lease: unknown = JSON.parse(raw);
  if (
    typeof lease !== "object" ||
    lease === null ||
    !("pid" in lease) ||
    !Number.isInteger(lease.pid) ||
    Number(lease.pid) <= 0 ||
    !("bootId" in lease) ||
    typeof lease.bootId !== "string" ||
    !lease.bootId ||
    !("startTime" in lease) ||
    typeof lease.startTime !== "string" ||
    !lease.startTime
  )
    throw new Error(`Invalid watcher lease at ${pidFile}; inspect it before reclaiming.`);
  return lease as WatcherLease;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameIdentity(left: WatcherLease, right: WatcherLease): boolean {
  // Accept older Darwin leases without comparing their drifting usec/date suffix.
  const bootId = (raw: string) => /\bsec\s*=\s*(\d+)\b/.exec(raw)?.[1] ?? raw;
  return (
    left.pid === right.pid &&
    bootId(left.bootId) === bootId(right.bootId) &&
    left.startTime === right.startTime
  );
}

const openLock = NodeUtil.promisify(NodeFS.open);
const closeLock = NodeUtil.promisify(NodeFS.close);
const truncateLock = NodeUtil.promisify(NodeFS.ftruncate);
const writeLock = NodeUtil.promisify(NodeFS.writeFile);

/** The raw FD holds flock for the watcher lifetime, even if the lease disappears. */
async function acquireWatcherLock(pidFile: string): Promise<number | null> {
  await NodeFSP.mkdir(NodePath.dirname(pidFile), { recursive: true });
  const fd = await openLock(
    `${pidFile}.lock`,
    NodeFS.constants.O_CREAT | NodeFS.constants.O_RDWR,
    0o600,
  );
  try {
    const acquired = await new Promise<boolean>((resolve, reject) => {
      const child = NodeChildProcess.spawn("/usr/bin/perl", ["-e", THREAD_ROUTING_LOCK_HELPER], {
        stdio: ["ignore", "ignore", "pipe", fd],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve(true);
        else if (code === 1) resolve(false);
        else reject(new Error(`Watcher lock helper failed (${signal ?? code}): ${stderr.trim()}`));
      });
    });
    if (acquired) return fd;
    await closeLock(fd);
    return null;
  } catch (error) {
    await closeLock(fd);
    throw error;
  }
}

/** Returns the matching live owner, or reclaims only a provably stale lease. */
async function liveWatcher(pidFile: string): Promise<WatcherLease | null> {
  const lease = await readWatcherLease(pidFile);
  if (lease === null) return null;
  if (typeof lease === "number") {
    if (isProcessRunning(lease)) {
      throw new Error(
        `Cannot verify live legacy watcher PID ${lease} at ${pidFile}; inspect its owner before removing the lease.`,
      );
    }
  } else {
    const identity = await readProcessIdentity(lease.pid);
    if (identity && sameIdentity(lease, identity)) return lease;
  }
  await NodeFSP.unlink(pidFile);
  return null;
}

export async function claimWatcherLease(): Promise<(() => Promise<void>) | null> {
  const pidFile = watcherPidFile();
  let fd: number | null = null;
  try {
    // Serialize lock admission and owner recording so ensure never sees a partial owner.
    const lease = await updateState(async (state) => {
      fd = await acquireWatcherLock(pidFile);
      if (fd === null) return { state, result: null };
      await truncateLock(fd, 0);
      await writeLock(fd, `${process.pid}\n`, "utf8");
      if (await liveWatcher(pidFile)) return { state, result: null };
      const identity = await readProcessIdentity(process.pid);
      if (!identity) throw new Error("Cannot identify the current watcher process.");
      await NodeFSP.writeFile(pidFile, `${JSON.stringify(identity)}\n`, "utf8");
      return { state, result: identity };
    });
    if (!lease || fd === null) {
      if (fd !== null) await closeLock(fd);
      return null;
    }
    const heldFd = fd;
    fd = null;
    return async () => {
      try {
        await updateState(async (state) => {
          const current = await readWatcherLease(pidFile);
          if (current && typeof current !== "number" && sameIdentity(current, lease)) {
            await NodeFSP.unlink(pidFile);
          }
          return { state, result: undefined };
        });
      } finally {
        // Keep the persistent lock inode; process exit also closes this descriptor.
        await closeLock(heldFd);
      }
    };
  } catch (error) {
    if (fd !== null) await closeLock(fd);
    throw error;
  }
}

export async function ensureWatcherProcess(input: {
  env?: string;
  intervalSeconds: number;
  idleExitSeconds: number;
  maxLifetimeSeconds: number;
  deliver: boolean;
}): Promise<WatcherEnsureResult> {
  const pidFile = watcherPidFile();
  const existing = await updateState(async (state) => {
    const fd = await acquireWatcherLock(pidFile);
    if (fd === null) {
      const owner = Number((await NodeFSP.readFile(`${pidFile}.lock`, "utf8")).trim());
      if (!Number.isInteger(owner) || owner <= 0)
        throw new Error("Cannot identify watcher lock owner.");
      return { state, result: { pid: owner } };
    }
    try {
      return { state, result: await liveWatcher(pidFile) };
    } finally {
      await closeLock(fd);
    }
  });
  if (existing) return { status: "already-running", pid: existing.pid };

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
