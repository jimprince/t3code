import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveStateFile } from "./state.js";

export const DEFAULT_IDLE_EXIT_SECONDS = 900; // 15 minutes

/** Pidfile lives next to the state file so it follows T3_AGENT_STATE_FILE overrides. */
export function watcherPidFile(): string {
  return path.join(path.dirname(resolveStateFile()), "watch.pid");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process (dead). EPERM = exists but not signalable by us (alive).
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export async function readWatcherPid(): Promise<number | null> {
  try {
    const raw = await readFile(watcherPidFile(), "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True when a *different*, live watcher process owns the pidfile. */
export async function isWatcherRunning(): Promise<boolean> {
  const pid = await readWatcherPid();
  return pid !== null && pid !== process.pid && isProcessAlive(pid);
}

export async function writeWatcherPid(): Promise<void> {
  await writeFile(watcherPidFile(), `${process.pid}\n`, "utf8");
}

/** Remove the pidfile only if it still points at this process. */
export async function clearOwnWatcherPid(): Promise<void> {
  const pid = await readWatcherPid();
  if (pid === process.pid) {
    await unlink(watcherPidFile()).catch(() => {});
  }
}

/**
 * Spawn a detached background watcher if none is running. Best-effort: any failure
 * resolves false rather than throwing, so it never breaks the caller (create/subscribe).
 * Re-invokes the current launcher (node + execArgv + entry script) so it works under
 * both `tsx src/cli.ts` (dev) and the bundled `dist/cli.cjs` (installed) paths.
 */
export async function ensureWatcherRunning(
  options: { idleExitSeconds?: number } = {},
): Promise<boolean> {
  try {
    if (await isWatcherRunning()) {
      return false;
    }
    const idle = options.idleExitSeconds ?? DEFAULT_IDLE_EXIT_SECONDS;
    const entry = process.argv[1];
    if (!entry) {
      return false;
    }
    const args = [...process.execArgv, entry, "watch", "--idle-exit", String(idle)];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
