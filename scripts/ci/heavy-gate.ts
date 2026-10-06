/* oxlint-disable t3code/no-global-process-runtime -- Standalone script with no Effect runtime. */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalConsole:off
// Admission preamble for the repo's heaviest package scripts (typecheck, test).
// `node heavy-gate.ts COMMAND [ARG ...]` runs COMMAND through the dev VM's shared
// heavy-check slot, and runs it directly everywhere that slot does not exist.
//
// COMMAND runs directly, with argv and exit status unchanged, when:
//   - CI is set, the host is not Linux, or T3_HEAVY_GATE_DISABLE=1;
//   - the gate executable is absent (the Mac, CI runners, other checkouts);
//   - this process already holds the slot: T3_HEAVY_GATE_HELD marks a descendant
//     of a gated command, and an ancestor holding heavy-check.lock marks a caller
//     that used heavy-check directly, whose flock a second acquisition would
//     deadlock on.
//
// heavy-check keeps the slot only while the process it execs (or something that
// inherited its fd) lives, but vp spawns tsc and vitest without that fd, and they
// can outlive it. So the gated command runs under a supervisor inside the slot:
// the supervisor starts COMMAND in its own session, tags every descendant with a
// per-run T3_HEAVY_GATE_HELD token, and exits only once no process carrying the
// token remains, which is also when the slot is released. A process left after
// T3_HEAVY_GATE_LINGER_MS (default 30 minutes) is reported and stops holding the
// slot; it is not killed unless the gate was signalled (see supervise).
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const LOCK_SUFFIX = process.env.T3_HEAVY_GATE_LOCK ?? "/heavy-check.lock";
const SUPERVISE = "T3_HEAVY_GATE_SUPERVISE";
const HELD = "T3_HEAVY_GATE_HELD";

const readParent = (pid: number): number => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
};

const hasLockFd = (pid: number): boolean => {
  try {
    return NodeFS.readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try {
        return NodeFS.readlinkSync(`/proc/${pid}/fd/${fd}`).endsWith(LOCK_SUFFIX);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

const ancestorHoldsSlot = (): boolean => {
  for (let pid = process.pid; pid > 1; pid = readParent(pid)) {
    if (hasLockFd(pid)) return true;
  }
  return false;
};

const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

const taggedPids = (token: string): number[] => {
  const needle = `${HELD}=${token}\0`;
  const pids: number[] = [];
  for (const entry of NodeFS.readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      if (NodeFS.readFileSync(`/proc/${pid}/environ`, "latin1").includes(needle)) pids.push(pid);
    } catch {
      // exited, a zombie, or not ours
    }
  }
  return pids;
};

const signalTagged = (token: string, signal: NodeJS.Signals): void => {
  for (const pid of taggedPids(token)) {
    try {
      process.kill(pid, signal);
    } catch {
      // exited meanwhile
    }
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const forwardSignals = (deliver: (signal: NodeJS.Signals) => void): (() => void) => {
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = () => deliver(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
};

const finish = (code: number | null, signal: NodeJS.Signals | null): never => {
  if (signal !== null) process.kill(process.pid, signal);
  return process.exit(code ?? 1);
};

const runDirect = (command: string, args: readonly string[]): void => {
  const child = NodeChildProcess.spawn(command, args, {
    stdio: "inherit",
    shell: NodeOS.platform() === "win32",
  });
  const stop = forwardSignals((signal) => child.kill(signal));
  child.on("error", (error) => {
    console.error(`heavy-gate: cannot run ${command}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    stop();
    finish(code, signal);
  });
};

// Runs inside the slot: start COMMAND in its own session and hold until its tree is gone.
// A signal is passed to the command and to every tagged descendant, which are found by
// token, not by process group, so a daemonized child is reached too. Survivors of
// T3_HEAVY_GATE_KILL_GRACE_MS (default 10s) after a signal are killed; the tree carries
// this run's unique token, so nothing else is touched.
const supervise = (command: string, args: readonly string[]): void => {
  const token = process.env[SUPERVISE] ?? "";
  const { [SUPERVISE]: _, ...inherited } = process.env;
  const child = NodeChildProcess.spawn(command, args, {
    stdio: "inherit",
    detached: true,
    env: { ...inherited, [HELD]: token },
  });
  let signalledAt: number | undefined;
  const stop = forwardSignals((signal) => {
    signalledAt ??= Date.now();
    try {
      process.kill(-(child.pid ?? 0), signal);
    } catch {
      child.kill(signal);
    }
    signalTagged(token, signal);
  });
  child.on("error", (error) => {
    console.error(`heavy-gate: cannot run ${command}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", async (code, signal) => {
    const lingerMs = Number(process.env.T3_HEAVY_GATE_LINGER_MS ?? 30 * 60_000);
    const graceMs = Number(process.env.T3_HEAVY_GATE_KILL_GRACE_MS ?? 10_000);
    const deadline = Date.now() + lingerMs;
    for (let left = taggedPids(token); left.length > 0; left = taggedPids(token)) {
      if (signalledAt !== undefined && Date.now() >= signalledAt + graceMs) {
        signalTagged(token, "SIGKILL");
      }
      if (Date.now() >= deadline) {
        console.error(
          `heavy-gate: ${left.length} process(es) from ${command} outlived it by ` +
            `${Math.round(lingerMs / 1000)}s; releasing the heavy-check slot (they are not killed)`,
        );
        break;
      }
      await sleep(250);
    }
    stop();
    finish(code, signal);
  });
};

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("usage: heavy-gate COMMAND [ARG ...]");
  process.exit(64);
}

const env = process.env;
if (env[SUPERVISE]) {
  supervise(command, args);
} else {
  const gate = env.T3_HEAVY_GATE ?? NodePath.join(NodeOS.homedir(), ".local/bin/heavy-check");
  const direct =
    Boolean(env.CI) ||
    env.T3_HEAVY_GATE_DISABLE === "1" ||
    Boolean(env[HELD]) ||
    NodeOS.platform() !== "linux" ||
    !isExecutable(gate) ||
    ancestorHoldsSlot();
  if (direct) {
    runDirect(command, args);
  } else {
    const child = NodeChildProcess.spawn(
      gate,
      [process.execPath, process.argv[1] ?? "", command, ...args],
      { stdio: "inherit", env: { ...env, [SUPERVISE]: NodeCrypto.randomUUID() } },
    );
    const stop = forwardSignals((signal) => child.kill(signal));
    child.on("error", (error) => {
      console.error(`heavy-gate: cannot run ${gate}: ${error.message}`);
      process.exit(127);
    });
    child.on("exit", (code, signal) => {
      stop();
      finish(code, signal);
    });
  }
}
