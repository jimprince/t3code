// @effect-diagnostics nodeBuiltinImport:off -- The watchdog tests run the real script against a temporary bundle.
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  armUpdateRollback,
  make,
  resolveUpdateRollbackPaths,
  takeUpdateRollbackRecord,
  UPDATE_ROLLBACK_WATCHDOG_SCRIPT,
  type UpdateRollbackDependencies,
  type UpdateRollbackPaths,
} from "./DesktopUpdateRollback.ts";

const paths = resolveUpdateRollbackPaths({
  platform: "darwin",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code (Fork).app/Contents/Resources",
  stateDir: "/Users/brad/.t3/userdata",
  logDir: "/Users/brad/.t3/userdata/logs",
})!;

function dependencies(
  overrides: Partial<UpdateRollbackDependencies> = {},
): UpdateRollbackDependencies {
  return {
    rename: vi.fn(async () => undefined),
    copyBundle: vi.fn(async () => undefined),
    spawnWatchdog: vi.fn(() => 4242),
    stopWatchdog: vi.fn(),
    makeDirectory: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    readText: vi.fn(async () => null),
    writeText: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("resolveUpdateRollbackPaths", () => {
  it("protects only a packaged macOS app running from its bundle", () => {
    expect(paths).toEqual({
      bundle: "/Applications/T3 Code (Fork).app",
      backup: "/Users/brad/.t3/userdata/update-rollback/previous-app",
      health: "/Users/brad/.t3/userdata/update-rollback/healthy-version",
      record: "/Users/brad/.t3/userdata/update-rollback/rolled-back.json",
      log: "/Users/brad/.t3/userdata/logs/update-rollback.log",
    });
    const base = { isPackaged: true, stateDir: "/s", logDir: "/l" };
    expect(
      resolveUpdateRollbackPaths({ ...base, platform: "darwin", resourcesPath: "/missing/res" }),
    ).toBeNull();
    expect(
      resolveUpdateRollbackPaths({
        ...base,
        platform: "linux",
        resourcesPath: "/opt/T3.app/Contents/Resources",
      }),
    ).toBeNull();
  });
});

describe("armUpdateRollback", () => {
  it("clears the old health marker, copies the bundle, then starts the watchdog", async () => {
    const deps = dependencies();
    await expect(
      armUpdateRollback(paths, { current: "1.0.0", expected: "1.1.0" }, deps),
    ).resolves.toBe(4242);

    expect(deps.remove).toHaveBeenCalledWith(paths.health);
    expect(deps.copyBundle).toHaveBeenCalledWith(
      paths.bundle,
      expect.stringContaining(`${paths.backup}.preparing-`),
    );
    expect(deps.rename).toHaveBeenCalledWith(
      expect.stringContaining(`${paths.backup}.preparing-`),
      paths.backup,
    );
    expect(deps.spawnWatchdog).toHaveBeenCalledWith(
      [
        paths.bundle,
        paths.backup,
        "1.1.0",
        "1.0.0",
        paths.health,
        paths.record,
        "5",
        "120",
        "/usr/bin/open",
      ],
      paths.log,
    );
  });

  it("retains the old backup and starts no watchdog when the copy fails", async () => {
    const deps = dependencies({
      copyBundle: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    await expect(
      armUpdateRollback(paths, { current: "1.0.0", expected: "1.1.0" }, deps),
    ).rejects.toThrow("disk full");
    expect(deps.spawnWatchdog).not.toHaveBeenCalled();
    expect(deps.rename).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });
  it("arms a fresh copy despite ENOTEMPTY while cleaning the stale backup", async () => {
    const deps = dependencies({
      remove: vi.fn(async (path) => {
        if (path.includes(".stale-"))
          throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
      }),
    });
    expect(await armUpdateRollback(paths, { current: "1.0.0", expected: "1.1.0" }, deps)).toBe(
      4242,
    );
    expect(deps.remove).not.toHaveBeenCalledWith(paths.backup);
    expect(deps.spawnWatchdog).toHaveBeenCalledTimes(1);
  });

  it("refuses installation when no watchdog was spawned", async () => {
    const deps = dependencies({ spawnWatchdog: vi.fn(() => undefined) });
    await expect(armUpdateRollback(paths, { current: "1", expected: "2" }, deps)).rejects.toThrow(
      "not installed",
    );
    expect(deps.remove).not.toHaveBeenCalledWith(paths.backup);
  });
});

describe("takeUpdateRollbackRecord", () => {
  it("reports a rollback once and keeps its version", async () => {
    const stored =
      '{"version":"1.1.0","previousVersion":"1.0.0","outcome":"rolled-back","at":"2026-09-27T09:00:00Z"}';
    const deps = dependencies({ readText: vi.fn(async () => stored) });

    await expect(takeUpdateRollbackRecord(paths, deps)).resolves.toMatchObject({
      version: "1.1.0",
      notified: false,
    });
    expect(deps.notify).toHaveBeenCalledWith(
      "Update rolled back",
      "T3 Code 1.1.0 did not start, so 1.0.0 was restored. The next release will install instead.",
    );
    const rewritten = vi.mocked(deps.writeText).mock.calls[0]![1];
    expect(JSON.parse(rewritten)).toMatchObject({ version: "1.1.0", notified: true });

    const again = dependencies({ readText: vi.fn(async () => rewritten) });
    await expect(takeUpdateRollbackRecord(paths, again)).resolves.toMatchObject({
      version: "1.1.0",
    });
    expect(again.notify).not.toHaveBeenCalled();
  });
});

describe("update rollback watchdog", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
  });

  function fixture(): UpdateRollbackPaths & { readonly opened: string } {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-watchdog-"));
    roots.push(root);
    const bundle = NodePath.join(root, "Applications", "T3 Code (Fork).app");
    const backup = NodePath.join(root, "state", "update-rollback", "previous-app");
    for (const [dir, version] of [
      [bundle, "1.1.0"],
      [backup, "1.0.0"],
    ] as const) {
      NodeFS.mkdirSync(NodePath.join(dir, "Contents", "MacOS"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "Contents", "version"), version);
    }
    return {
      bundle,
      backup,
      health: NodePath.join(root, "state", "update-rollback", "healthy-version"),
      record: NodePath.join(root, "state", "update-rollback", "rolled-back.json"),
      log: NodePath.join(root, "watchdog.log"),
      opened: NodePath.join(root, "opened"),
    };
  }

  function runWatchdog(fx: ReturnType<typeof fixture>): Promise<number | null> {
    const opener = NodePath.join(NodePath.dirname(fx.opened), "open");
    NodeFS.writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > '${fx.opened}'\n`, {
      mode: 0o755,
    });
    const args = [fx.bundle, fx.backup, "1.1.0", "1.0.0", fx.health, fx.record, "0.05", "3"];
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", UPDATE_ROLLBACK_WATCHDOG_SCRIPT, "t3-update-watchdog", ...args, opener],
      { stdio: "ignore" },
    );
    return new Promise((resolve) => child.on("exit", resolve));
  }

  const bundleVersion = (fx: UpdateRollbackPaths) =>
    NodeFS.readFileSync(NodePath.join(fx.bundle, "Contents", "version"), "utf8");

  it("keeps a healthy update and drops the backup", async () => {
    const fx = fixture();
    NodeFS.writeFileSync(fx.health, "1.1.0");

    expect(await runWatchdog(fx)).toBe(0);
    expect(bundleVersion(fx)).toBe("1.1.0");
    expect(NodeFS.existsSync(fx.backup)).toBe(false);
    expect(NodeFS.existsSync(fx.record)).toBe(false);
  });

  it("stops the unhealthy app, restores the previous bundle, and relaunches it", async () => {
    const fx = fixture();
    const executable = NodePath.join(fx.bundle, "Contents", "MacOS", "T3 Code (Fork)");
    NodeFS.copyFileSync("/bin/sleep", executable);
    NodeFS.chmodSync(executable, 0o755);
    const app = NodeChildProcess.spawn(executable, ["30"], { stdio: "ignore" });
    const appExit = new Promise((resolve) => app.on("exit", (_code, signal) => resolve(signal)));

    expect(await runWatchdog(fx)).toBe(0);
    expect(await appExit).toBe("SIGTERM");
    expect(bundleVersion(fx)).toBe("1.0.0");
    expect(NodeFS.readFileSync(fx.opened, "utf8")).toBe(fx.bundle);
    expect(JSON.parse(NodeFS.readFileSync(fx.record, "utf8"))).toMatchObject({
      version: "1.1.0",
      previousVersion: "1.0.0",
      outcome: "rolled-back",
    });
    expect(NodeFS.existsSync(fx.backup)).toBe(false);
    expect(NodeFS.existsSync(`${fx.bundle}.failed-update`)).toBe(false);
  });

  it("records an update that never applied without touching the running app", async () => {
    const fx = fixture();
    NodeFS.writeFileSync(fx.health, "1.0.0");

    expect(await runWatchdog(fx)).toBe(0);
    expect(bundleVersion(fx)).toBe("1.1.0");
    expect(NodeFS.existsSync(fx.opened)).toBe(false);
    expect(JSON.parse(NodeFS.readFileSync(fx.record, "utf8"))).toMatchObject({
      version: "1.1.0",
      outcome: "not-applied",
    });
  });
});

effectIt.effect(
  "the updater receives a preparation failure instead of proceeding unprotected",
  () =>
    Effect.gen(function* () {
      const rollback = yield* make({
        paths,
        appVersion: "1",
        dependencies: dependencies({
          copyBundle: async () => {
            throw new Error("disk full");
          },
        }),
      });
      const result = yield* rollback.arm("2").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("rollback protection could not be prepared");
      }
    }),
);
it("restores the current bundle after stale cleanup ENOTEMPTY and an unhealthy launch", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rollback-swap-"));
  try {
    const fixture: UpdateRollbackPaths = {
      bundle: `${root}/T3.app`,
      backup: `${root}/state/previous-app`,
      health: `${root}/state/healthy`,
      record: `${root}/state/record.json`,
      log: `${root}/logs/watchdog.log`,
    };
    await NodeFSP.mkdir(`${fixture.bundle}/Contents/Resources`, { recursive: true });
    await NodeFSP.writeFile(`${fixture.bundle}/Contents/Resources/version`, "previous-working");
    await NodeFSP.mkdir(fixture.backup, { recursive: true });
    await NodeFSP.writeFile(`${fixture.backup}/stale`, "older-backup");
    const deps = dependencies({
      copyBundle: (from, to) => NodeFSP.cp(from, to, { recursive: true }),
      rename: NodeFSP.rename,
      makeDirectory: async (path) => {
        await NodeFSP.mkdir(path, { recursive: true });
      },
      remove: async (path) => {
        if (path.includes(".stale-"))
          throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
        await NodeFSP.rm(path, { recursive: true, force: true });
      },
    });
    await armUpdateRollback(fixture, { current: "1", expected: "2" }, deps);
    expect(await NodeFSP.readFile(`${fixture.backup}/Contents/Resources/version`, "utf8")).toBe(
      "previous-working",
    );
    await NodeFSP.writeFile(`${fixture.bundle}/Contents/Resources/version`, "unhealthy-update");
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      [
        "-c",
        UPDATE_ROLLBACK_WATCHDOG_SCRIPT,
        "watchdog",
        fixture.bundle,
        fixture.backup,
        "2",
        "1",
        fixture.health,
        fixture.record,
        "0",
        "0",
        "/usr/bin/true",
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await NodeFSP.readFile(fixture.record, "utf8")).outcome).toBe("rolled-back");
    expect(await NodeFSP.readFile(`${fixture.bundle}/Contents/Resources/version`, "utf8")).toBe(
      "previous-working",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
