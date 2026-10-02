// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - shared Node boundary for the Promise-based CLI and server, preserving the CLI filesystem lock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const DEFAULT_STATE_DIR = NodePath.join(NodeOS.homedir(), ".config", "t3-remote-agents");
const DEFAULT_STATE_FILE = NodePath.join(DEFAULT_STATE_DIR, "state.json");
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_RETRY_MS = 50;
const openLockFile = NodeUtil.promisify(NodeFS.open);
const closeLockFile = NodeUtil.promisify(NodeFS.close);
const truncateLockFile = NodeUtil.promisify(NodeFS.ftruncate);
const writeLockFile = NodeUtil.promisify(NodeFS.writeFile);

export function resolveStateFile(): string {
  return process.env.T3_AGENT_STATE_FILE?.trim() || DEFAULT_STATE_FILE;
}

async function ensureStateDir(stateFile: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(stateFile), { recursive: true });
}

async function loadStateFromFile<T>(stateFile: string, empty: T): Promise<T> {
  try {
    const raw = await NodeFSP.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return structuredClone(empty);
    }
    throw error;
  }
}

export async function loadState<T>(empty: T): Promise<T> {
  return loadStateFromFile(resolveStateFile(), empty);
}

async function saveStateToFile<T>(stateFile: string, state: T): Promise<void> {
  await ensureStateDir(stateFile);
  const tempFile = NodePath.join(
    NodePath.dirname(stateFile),
    `.${NodePath.basename(stateFile)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  await NodeFSP.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await NodeFSP.rename(tempFile, stateFile);
}

export async function saveState<T>(state: T): Promise<void> {
  await saveStateToFile(resolveStateFile(), state);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// flock belongs to the inherited open file description, so the parent's FD
// retains it after Perl exits. Never unlink this sidecar: that splits the lock.
export const THREAD_ROUTING_LOCK_HELPER = `use Fcntl qw(:flock);
open(my $fh, '>&=', 3) or die "Cannot open inherited state lock: $!";
if (flock($fh, LOCK_EX | LOCK_NB)) { exit 0; }
exit 1;`;

async function tryStateLock(fd: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const unavailable = (cause: unknown) =>
      new Error("State locking requires /usr/bin/perl with built-in flock on this host.", {
        cause,
      });
    try {
      const child = NodeChildProcess.spawn("/usr/bin/perl", ["-e", THREAD_ROUTING_LOCK_HELPER], {
        stdio: ["ignore", "ignore", "pipe", fd],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => reject(unavailable(error)));
      child.once("close", (code, signal) => {
        if (code === 0) resolve(true);
        else if (code === 1) resolve(false);
        else reject(new Error(`State lock helper failed (${signal ?? code}): ${stderr.trim()}`));
      });
    } catch (error) {
      reject(unavailable(error));
    }
  });
}

async function withStateLock<T>(stateFile: string, task: () => Promise<T>): Promise<T> {
  await ensureStateDir(stateFile);
  const lockFile = `${stateFile}.lock`;
  // A raw FD has no FileHandle finalizer. An unresolved mutator's Promise chain
  // can be collected even while its process remains alive; that must not unlock.
  const fd = await openLockFile(
    lockFile,
    NodeFS.constants.O_CREAT | NodeFS.constants.O_RDWR,
    0o600,
  );
  const startedAt = Date.now();
  try {
    let retryMs = STATE_LOCK_RETRY_MS;
    while (!(await tryStateLock(fd))) {
      const remainingMs = STATE_LOCK_TIMEOUT_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        const holder = (await NodeFSP.readFile(lockFile, "utf8").catch(() => "")).trim();
        const detail = /^\d+$/.test(holder) ? ` Last recorded holder: PID ${holder}.` : "";
        throw new Error(`Timed out waiting for state lock '${lockFile}' after 10 s.${detail}`);
      }
      await sleep(Math.min(retryMs, remainingMs));
      retryMs = Math.min(retryMs * 2, 250);
    }
    await truncateLockFile(fd, 0);
    await writeLockFile(fd, `${process.pid}\n`, "utf8");
    return await task();
  } finally {
    await closeLockFile(fd);
  }
}

export async function updateState<S, T>(
  empty: S,
  mutator: (state: S) => Promise<{ state: S; result: T }> | { state: S; result: T },
): Promise<T> {
  const stateFile = resolveStateFile();
  return withStateLock(stateFile, async () => {
    const current = await loadStateFromFile(stateFile, empty);
    const { state, result } = await mutator(current);
    await saveStateToFile(stateFile, state);
    return result;
  });
}
