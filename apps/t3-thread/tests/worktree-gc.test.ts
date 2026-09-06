import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  runWorktreeGc,
  inspectWorktree,
  planWorktreeGc,
  removeWorktree,
  type WorktreeGcThread,
  type WorktreeInspector,
  type WorktreeState,
} from "../src/worktreeGc.js";

import { RemoteEnvironmentClient } from "../src/client.js";
import type { SavedEnvironment } from "../src/types.js";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const LONG_AGO = "2026-08-01T00:00:00.000Z";
const YESTERDAY = "2026-09-03T00:00:00.000Z";

function thread(overrides: Partial<WorktreeGcThread> & { id: string }): WorktreeGcThread {
  return {
    worktreePath: `/worktrees/${overrides.id}`,
    archivedAt: LONG_AGO,
    session: null,
    latestTurn: null,
    ...overrides,
  };
}

const alwaysClean: WorktreeInspector = () => Promise.resolve({ kind: "clean" });

function inspectorSpy(state: WorktreeState): {
  inspect: WorktreeInspector;
  inspected: string[];
} {
  const inspected: string[] = [];
  return {
    inspected,
    inspect: (path) => {
      inspected.push(path);
      return Promise.resolve(state);
    },
  };
}

describe("worktree gc planning", () => {
  it("retires a worktree whose threads are all archived past the recovery window", async () => {
    const plan = await planWorktreeGc({
      threads: [thread({ id: "a" }), thread({ id: "b", worktreePath: "/worktrees/a" })],
      inspect: alwaysClean,
      now: NOW,
    });

    expect(plan.removable).toEqual([
      { path: "/worktrees/a", threadIds: ["a", "b"], archivedAt: LONG_AGO },
    ]);
    expect(plan.retained).toEqual([]);
  });

  it("never removes a worktree that still has an unarchived thread", async () => {
    const spy = inspectorSpy({ kind: "clean" });
    const plan = await planWorktreeGc({
      threads: [
        thread({ id: "archived", worktreePath: "/worktrees/shared" }),
        thread({ id: "live", worktreePath: "/worktrees/shared", archivedAt: null }),
      ],
      inspect: spy.inspect,
      now: NOW,
    });

    expect(plan.removable).toEqual([]);
    expect(plan.retained[0]?.reason).toBe("unarchived-thread");
    // A checkout that is still in use is never even inspected.
    expect(spy.inspected).toEqual([]);
  });

  it("never removes a worktree whose archived thread still reports active work", async () => {
    const plan = await planWorktreeGc({
      threads: [
        thread({
          id: "busy",
          session: { status: "running", activeTurnId: "turn-1" },
          latestTurn: { state: "running" },
        }),
      ],
      inspect: alwaysClean,
      now: NOW,
    });

    expect(plan.removable).toEqual([]);
    expect(plan.retained[0]?.reason).toBe("active-turn");
  });

  it("keeps a recently archived worktree for the recovery window", async () => {
    const plan = await planWorktreeGc({
      threads: [thread({ id: "fresh", archivedAt: YESTERDAY })],
      inspect: alwaysClean,
      now: NOW,
      recoveryWindowDays: 7,
    });

    expect(plan.removable).toEqual([]);
    expect(plan.retained[0]?.reason).toBe("recovery-window");
  });

  it("never removes a worktree with local changes", async () => {
    const plan = await planWorktreeGc({
      threads: [thread({ id: "dirty" })],
      inspect: () => Promise.resolve({ kind: "dirty", detail: "?? scratch.txt" }),
      now: NOW,
    });

    expect(plan.removable).toEqual([]);
    expect(plan.retained[0]).toEqual({
      path: "/worktrees/dirty",
      threadIds: ["dirty"],
      reason: "dirty",
      detail: "?? scratch.txt",
    });
  });

  it("ignores threads without a worktree path", async () => {
    const plan = await planWorktreeGc({
      threads: [thread({ id: "none", worktreePath: null })],
      inspect: alwaysClean,
      now: NOW,
    });

    expect(plan).toEqual({ removable: [], retained: [] });
  });
});

async function git(args: ReadonlyArray<string>, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile("git", [...args], { cwd }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function withRepo(
  test: (paths: { root: string; main: string; clean: string; dirty: string }) => Promise<void>,
): Promise<void> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-worktree-gc-")),
  );
  const main = NodePath.join(root, "main");
  await NodeFSP.mkdir(main);
  await git(["init", "--initial-branch=main", "."], main);
  await git(["config", "user.email", "gc@test.invalid"], main);
  await git(["config", "user.name", "gc test"], main);
  await NodeFSP.writeFile(NodePath.join(main, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], main);
  await git(["-c", "commit.gpgsign=false", "commit", "-m", "init"], main);

  const clean = NodePath.join(root, "clean");
  const dirty = NodePath.join(root, "dirty");
  await git(["worktree", "add", "-b", "worker-clean", clean], main);
  await git(["worktree", "add", "-b", "worker-dirty", dirty], main);
  await NodeFSP.writeFile(NodePath.join(dirty, "scratch.txt"), "wip\n", "utf8");

  try {
    await test({ root, main, clean, dirty });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe("worktree gc against real git state", () => {
  it("retains a clean detached worktree with an unreferenced commit", async () => {
    await withRepo(async ({ clean }) => {
      await git(["checkout", "--detach"], clean);
      await git(
        ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "detached work"],
        clean,
      );
      const plan = await planWorktreeGc({
        threads: [thread({ id: "detached", worktreePath: clean })],
        inspect: inspectWorktree,
        now: NOW,
      });
      expect(plan.removable).toEqual([]);
      expect(plan.retained[0]?.reason).toBe("detached-head");
      await expect(NodeFSP.access(clean)).resolves.toBeUndefined();
    });
  });
  it("retains an archived path when an active thread uses a symlink alias", async () => {
    await withRepo(async ({ root, clean }) => {
      const alias = NodePath.join(root, "alias");
      await NodeFSP.symlink(clean, alias, "dir");
      const plan = await planWorktreeGc({
        threads: [
          thread({ id: "old", worktreePath: clean }),
          thread({ id: "active", worktreePath: alias, archivedAt: null }),
        ],
        inspect: inspectWorktree,
        now: NOW,
      });
      expect(plan.removable).toEqual([]);
      expect(plan.retained).toHaveLength(1);
      expect(plan.retained[0]?.reason).toBe("unarchived-thread");
      expect(await inspectWorktree(alias)).toEqual({ kind: "clean" });
    });
  });
  it("classifies clean, dirty, main and missing paths", async () => {
    await withRepo(async ({ root, main, clean, dirty }) => {
      expect(await inspectWorktree(clean)).toEqual({ kind: "clean" });
      expect((await inspectWorktree(dirty)).kind).toBe("dirty");
      expect((await inspectWorktree(main)).kind).toBe("not-a-linked-worktree");
      expect((await inspectWorktree(NodePath.join(root, "gone"))).kind).toBe("missing");
    });
  });

  it("removes only the clean worktree and keeps its branch", async () => {
    await withRepo(async ({ main, clean, dirty }) => {
      const plan = await planWorktreeGc({
        threads: [
          {
            id: "clean",
            worktreePath: clean,
            archivedAt: LONG_AGO,
            session: null,
            latestTurn: null,
          },
          {
            id: "dirty",
            worktreePath: dirty,
            archivedAt: LONG_AGO,
            session: null,
            latestTurn: null,
          },
        ],
        inspect: inspectWorktree,
        now: NOW,
      });

      expect(plan.removable.map((candidate) => candidate.path)).toEqual([NodePath.resolve(clean)]);
      expect(plan.retained.map((entry) => entry.reason)).toEqual(["dirty"]);

      expect(await removeWorktree(clean)).toEqual({ path: clean, removed: true });
      await expect(NodeFSP.access(clean)).rejects.toThrow();
      await expect(NodeFSP.access(NodePath.join(dirty, "scratch.txt"))).resolves.toBeUndefined();

      const branches = await new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          "git",
          ["branch", "--format=%(refname:short)"],
          { cwd: main, encoding: "utf8" },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      expect(branches.split("\n").map((line) => line.trim())).toContain("worker-clean");
    });
  });

  it("refuses to remove a dirty worktree even when asked directly", async () => {
    await withRepo(async ({ dirty }) => {
      const removal = await removeWorktree(dirty);
      expect(removal.removed).toBe(false);
      expect(removal.error).toContain("modified or untracked files");
      await expect(NodeFSP.access(NodePath.join(dirty, "scratch.txt"))).resolves.toBeUndefined();
    });
  });
});

describe("worktree gc snapshot integration", () => {
  it("finds archived candidates while retaining paths shared with active threads", async () => {
    const archived = [
      thread({ id: "old" }),
      thread({ id: "shared", worktreePath: "/worktrees/shared" }),
    ];
    const active = [thread({ id: "live", worktreePath: "/worktrees/shared", archivedAt: null })];
    const request = vi.fn(async () => ({ threads: archived }));
    const rpc = {
      request,
      subscribeShellSnapshot: vi.fn(async () => ({
        kind: "snapshot",
        snapshot: { projects: [], threads: active },
      })),
      subscribeThreadSnapshot: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const environment: SavedEnvironment = {
      name: "test",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      environmentId: "test",
      label: "Test",
      serverVersion: "0.1.0",
      bearerToken: "token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      pairedAt: "2026-09-04T00:00:00.000Z",
    };
    const client = new RemoteEnvironmentClient(environment, { rpcFactory: () => rpc });
    const plan = await planWorktreeGc({
      threads: await client.listWorktreeGcThreads(),
      inspect: alwaysClean,
      now: NOW,
    });
    expect(plan.removable.map(({ path }) => path)).toEqual(["/worktrees/old"]);
    expect(plan.retained.map(({ reason }) => reason)).toEqual(["unarchived-thread"]);
    expect(request).toHaveBeenCalledWith("getArchivedShellSnapshot", {});
  });
});

describe("worktree gc execution", () => {
  async function localState(run: (stateDir: string) => Promise<void>) {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gc-identity-"));
    try {
      await NodeFSP.writeFile(NodePath.join(stateDir, "environment-id"), "local-environment\n");
      await run(stateDir);
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }

  it("rejects another environment before inspecting local worktrees", async () => {
    await localState(async (localStateDir) => {
      const inspect = vi.fn(alwaysClean);
      const listThreads = vi.fn(async () => [thread({ id: "a" })]);
      const remove = vi.fn(async (path: string) => ({ path, removed: true }));
      await expect(
        runWorktreeGc({
          localStateDir,
          environmentId: "remote-environment",
          listThreads,
          inspect,
          remove,
          execute: true,
          now: NOW,
        }),
      ).rejects.toThrow("does not match");
      expect(inspect).not.toHaveBeenCalled();
      expect(listThreads).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });
  });

  it("rechecks lifecycle before each removal and keeps a newly reopened thread", async () => {
    await localState(async (localStateDir) => {
      const archived = [thread({ id: "a" }), thread({ id: "b" })];
      let reads = 0;
      const listThreads = async () =>
        ++reads < 3 ? archived : [archived[0]!, thread({ id: "b", archivedAt: null })];
      const removed: string[] = [];
      const result = await runWorktreeGc({
        localStateDir,
        environmentId: "local-environment",
        listThreads,
        inspect: alwaysClean,
        remove: async (path) => {
          removed.push(path);
          return { path, removed: true };
        },
        execute: true,
        now: NOW,
      });
      expect(removed).toEqual(["/worktrees/a"]);
      expect(result.removals[1]).toMatchObject({ path: "/worktrees/b", removed: false });
      expect(reads).toBe(3);
    });
  });

  it("keeps dry-run useful without removing or rereading candidates", async () => {
    await localState(async (localStateDir) => {
      const listThreads = vi.fn(async () => [thread({ id: "a" })]);
      const remove = vi.fn(async (path: string) => ({ path, removed: true }));
      const result = await runWorktreeGc({
        localStateDir,
        environmentId: "local-environment",
        listThreads,
        inspect: alwaysClean,
        remove,
        execute: false,
        now: NOW,
      });
      expect(result.removable).toHaveLength(1);
      expect(result.removals).toEqual([]);
      expect(listThreads).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
    });
  });
});
