import assert from "node:assert/strict";

import { Effect } from "effect";
import { describe, expect, it, vi, afterEach } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const createInterfaceMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:readline", () => ({
  default: {
    createInterface: createInterfaceMock,
  },
}));

import { OpenCodeServerPoolLive } from "./OpenCodeServerPool.ts";
import { OpenCodeServerPool } from "../Services/OpenCodeServerPool.ts";

function createChild(baseUrl: string) {
  const listeners = new Map<string, Array<(...args: Array<any>) => void>>();
  const stdoutListeners = new Map<string, Array<(...args: Array<any>) => void>>();

  const child = {
    pid: 1234,
    killed: false,
    stdout: {
      on: (event: string, cb: (...args: Array<any>) => void) => {
        const next = stdoutListeners.get(event) ?? [];
        next.push(cb);
        stdoutListeners.set(event, next);
      },
    },
    stderr: {
      on: vi.fn(),
    },
    on: (event: string, cb: (...args: Array<any>) => void) => {
      const next = listeners.get(event) ?? [];
      next.push(cb);
      listeners.set(event, next);
    },
    removeAllListeners: (event?: string) => {
      if (event) {
        listeners.delete(event);
        return;
      }
      listeners.clear();
    },
    kill: vi.fn(() => {
      child.killed = true;
    }),
  };

  const rl = {
    close: vi.fn(),
    on: vi.fn((event: string, cb: (line: string) => void) => {
      if (event === "line") {
        queueMicrotask(() => cb(`opencode server listening on ${baseUrl}`));
      }
      return rl;
    }),
    removeAllListeners: vi.fn(),
  };

  return { child: child as any, rl };
}

describe("OpenCodeServerPoolLive", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reuses one sidecar across worktrees in the same pool root", async () => {
    const first = createChild("http://127.0.0.1:4101");
    spawnMock.mockReturnValue(first.child);
    createInterfaceMock.mockReturnValue(first.rl);

    const pool = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* OpenCodeServerPool;
      }).pipe(Effect.provide(OpenCodeServerPoolLive)),
    );

    const leaseA = await Effect.runPromise(
      pool.acquire({ cwd: "/repo/worktrees/a", poolRoot: "/repo" }),
    );
    const leaseB = await Effect.runPromise(
      pool.acquire({ cwd: "/repo/worktrees/b", poolRoot: "/repo" }),
    );

    assert.equal(spawnMock.mock.calls.length, 1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: "/repo" });
    assert.equal(leaseA.key, leaseB.key);
    assert.equal(leaseA.poolRoot, "/repo");
    assert.equal(leaseB.poolRoot, "/repo");
    assert.equal(leaseA.cwd, "/repo/worktrees/a");
    assert.equal(leaseB.cwd, "/repo/worktrees/b");

    await Effect.runPromise(leaseA.release);
    assert.equal(first.child.kill.mock.calls.length, 0);

    await Effect.runPromise(leaseB.release);
    assert.equal(first.child.kill.mock.calls.length, 1);
  });

  it("separates sidecars by pool root and binary path", async () => {
    const first = createChild("http://127.0.0.1:4201");
    const second = createChild("http://127.0.0.1:4202");
    const third = createChild("http://127.0.0.1:4203");
    spawnMock
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
      .mockReturnValueOnce(third.child);
    createInterfaceMock
      .mockReturnValueOnce(first.rl as never)
      .mockReturnValueOnce(second.rl as never)
      .mockReturnValueOnce(third.rl as never);

    const pool = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* OpenCodeServerPool;
      }).pipe(Effect.provide(OpenCodeServerPoolLive)),
    );

    const leaseA = await Effect.runPromise(
      pool.acquire({ cwd: "/repo-a/worktree", poolRoot: "/repo-a" }),
    );
    const leaseB = await Effect.runPromise(
      pool.acquire({ cwd: "/repo-b/worktree", poolRoot: "/repo-b" }),
    );
    const leaseC = await Effect.runPromise(
      pool.acquire({
        cwd: "/repo-a/other-worktree",
        poolRoot: "/repo-a",
        binaryPath: "/opt/opencode/bin/opencode",
      }),
    );

    assert.equal(spawnMock.mock.calls.length, 3);
    assert.notEqual(leaseA.key, leaseB.key);
    assert.notEqual(leaseA.key, leaseC.key);

    await Effect.runPromise(leaseA.release);
    await Effect.runPromise(leaseB.release);
    await Effect.runPromise(leaseC.release);
  });
});
