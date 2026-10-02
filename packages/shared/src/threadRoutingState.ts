// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - shared Node boundary for the Promise-based CLI and server, preserving the CLI filesystem lock.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const DEFAULT_STATE_DIR = NodePath.join(NodeOS.homedir(), ".config", "t3-remote-agents");
const DEFAULT_STATE_FILE = NodePath.join(DEFAULT_STATE_DIR, "state.json");
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_RETRY_MS = 50;

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

async function withStateLock<T>(stateFile: string, task: () => Promise<T>): Promise<T> {
  await ensureStateDir(stateFile);
  const lockFile = `${stateFile}.lock`;
  const startedAt = Date.now();

  for (;;) {
    try {
      const handle = await NodeFSP.open(lockFile, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await task();
      } finally {
        await handle.close();
        await NodeFSP.unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EEXIST")) {
        throw error;
      }
      if (Date.now() - startedAt > STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for state lock '${lockFile}'.`, { cause: error });
      }
      await sleep(STATE_LOCK_RETRY_MS);
    }
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
