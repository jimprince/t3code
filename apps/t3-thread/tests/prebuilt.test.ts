import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { THREAD_ROUTING_LOCK_HELPER } from "@t3tools/shared/threadRoutingState";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));

describe("prebuilt launch", () => {
  beforeAll(async () => {
    await run(process.execPath, ["scripts/build.mjs"], { cwd: workspace });
  }, 30_000);

  it("runs the actual built CLI and watcher with no loader subprocesses; only the #220 flock helper", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-prebuilt-"));
    try {
      const guard = NodePath.join(temp, "no-spawn.cjs");
      const helperInvocations = NodePath.join(temp, "flock-helper-invocations.txt");
      await NodeFSP.writeFile(
        guard,
        `const cp = require('node:child_process');
         const fs = require('node:fs');
         const helperScript = ${JSON.stringify(THREAD_ROUTING_LOCK_HELPER)};
         for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
           const original = cp[key];
           cp[key] = (...callArgs) => {
             const [command, args, options] = callArgs;
             if ((key === 'spawn' || key === 'spawnSync') && command === '/usr/bin/perl' &&
                 Array.isArray(args) && args.length === 2 && args[0] === '-e' && args[1] === helperScript &&
                 Array.isArray(options?.stdio) && options.stdio.length === 4 &&
                 options.stdio[0] === 'ignore' && options.stdio[1] === 'ignore' && options.stdio[2] === 'pipe' &&
                 Number.isInteger(options.stdio[3]) && options.stdio[3] >= 0) {
               fs.appendFileSync(${JSON.stringify(helperInvocations)}, key + '\\n');
               return original.apply(cp, callArgs);
             }
             throw new Error('Unexpected child process');
           };
         }`,
      );
      const env = {
        ...process.env,
        T3_AGENT_STATE_FILE: NodePath.join(temp, "state.json"),
        NODE_OPTIONS: `--require=${guard}`,
      };
      const help = await run(process.execPath, ["scripts/launch.mjs", "--help"], {
        cwd: workspace,
        env,
      });
      expect(help.stdout).toContain("watch");
      const watch = await run(
        process.execPath,
        ["scripts/launch.mjs", "watch", "--once", "--no-deliver"],
        { cwd: workspace, env },
      );
      expect(JSON.parse(watch.stdout).workRemaining).toBe(false);
      const boundedWatch = await run(
        process.execPath,
        ["scripts/launch.mjs", "watch", "--no-deliver", "--idle-exit", "0", "--max-lifetime", "1"],
        { cwd: workspace, env, timeout: 4000 },
      );
      expect(boundedWatch.stdout).toContain('"scannedAt"');
      expect((await NodeFSP.readFile(helperInvocations, "utf8")).split("\n")).toContain("spawn");
      const blocked = await run(
        process.execPath,
        [
          "-e",
          `const assert = require('node:assert/strict');
           const cp = require('node:child_process');
           assert.throws(() => cp.spawn(process.execPath, []), /Unexpected child process/);
           assert.throws(() => cp.spawn('/usr/bin/perl', ['-e', 'exit 0']), /Unexpected child process/);
           assert.throws(() => cp.spawn('/usr/bin/perl', ['-e', ${JSON.stringify(THREAD_ROUTING_LOCK_HELPER)}]), /Unexpected child process/);
           assert.throws(() => cp.execFile('/usr/bin/perl', ['-e', ${JSON.stringify(THREAD_ROUTING_LOCK_HELPER)}]), /Unexpected child process/);
           console.log('guard enforced');`,
        ],
        { cwd: workspace, env },
      );
      expect(blocked.stdout.trim()).toBe("guard enforced");
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
    // Four real launches, one holding a watcher for a second: parallel CI needs headroom.
  }, 15_000);

  it("selects the build by default, refuses stale/missing builds and opts into tsx", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-wrapper-"));
    try {
      const ws = NodePath.join(temp, "apps/t3-thread");
      for (const dir of ["scripts", "src", "dist", "bin", "node_modules/.bin"])
        await NodeFSP.mkdir(NodePath.join(ws, dir), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(temp, "packages/contracts/src"), { recursive: true });
      for (const file of [
        "package.json",
        "pnpm-lock.yaml",
        "packages/contracts/package.json",
        "apps/t3-thread/package.json",
      ])
        await NodeFSP.writeFile(NodePath.join(temp, file), "{}");
      await NodeFSP.cp(
        NodePath.join(workspace, "scripts/launch.mjs"),
        NodePath.join(ws, "scripts/launch.mjs"),
      );
      await NodeFSP.cp(
        NodePath.join(workspace, "scripts/runtime-build.mjs"),
        NodePath.join(ws, "scripts/runtime-build.mjs"),
      );
      await NodeFSP.cp(
        NodePath.join(workspace, "bin/t3-thread"),
        NodePath.join(ws, "bin/t3-thread"),
      );
      await NodeFSP.writeFile(NodePath.join(ws, "dist/cli.cjs"), `console.log('built')`);
      await NodeFSP.writeFile(
        NodePath.join(ws, "node_modules/.bin/tsx"),
        '#!/bin/sh\nprintf "dev\\n"\n',
        {
          mode: 0o755,
        },
      );
      const env = {
        ...process.env,
        T3_THREAD_REPO: ws,
        T3_THREAD_NODE_BIN: process.execPath.slice(0, process.execPath.lastIndexOf("/")),
        T3_THREAD_DEV: "0",
      };
      const invoke = () => run("/bin/bash", [NodePath.join(ws, "bin/t3-thread")], { env });
      await expect(invoke()).rejects.toMatchObject({
        stderr: expect.stringContaining("No automatic rebuild"),
      });
      await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {sourceHash} from "./scripts/runtime-build.mjs"; import {writeFileSync} from "node:fs"; writeFileSync('dist/build-stamp.json', JSON.stringify({sourceHash:sourceHash(process.cwd())}));`,
        ],
        { cwd: ws },
      );
      expect((await invoke()).stdout.trim()).toBe("built");
      await NodeFSP.writeFile(NodePath.join(ws, "src/new.ts"), "// changed");
      await expect(invoke()).rejects.toMatchObject({
        stderr: expect.stringContaining("build is stale"),
      });
      expect(
        (
          await run("/bin/bash", [NodePath.join(ws, "bin/t3-thread")], {
            env: { ...env, T3_THREAD_DEV: "1" },
          })
        ).stdout.trim(),
      ).toBe("dev");
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });
});

it("streams unscoped agent status under a 512 MiB heap cap", async () => {
  await run(process.execPath, ["scripts/build.mjs"], { cwd: workspace });
  const result = await run(process.execPath, ["tests/fixtures/status-smoke.mjs"], {
    cwd: workspace,
    timeout: 195_000,
  });
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: "agent status",
    agents: 48,
    heapCapMiB: 512,
    status: "pass",
  });
}, 210_000);

it("streams threads JSON read-only under a 512 MiB heap cap", async () => {
  await run(process.execPath, ["scripts/build.mjs"], { cwd: workspace });
  const result = await run(process.execPath, ["tests/fixtures/threads-smoke.mjs"], {
    cwd: workspace,
    timeout: 60_000,
  });
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: "threads --json",
    heapCapMiB: 512,
    status: "pass",
  });
}, 65_000);
