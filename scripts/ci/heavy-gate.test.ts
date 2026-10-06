/* oxlint-disable t3code/no-global-process-runtime -- Standalone script with no Effect runtime. */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const gateScript = NodePath.join(repoRoot, "scripts/ci/heavy-gate.ts");

type RunResult = {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

const run = (
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
  onSpawn: (child: NodeChildProcess.ChildProcess) => void = () => {},
  prefix: readonly string[] = [process.execPath, gateScript],
): Promise<RunResult> =>
  new Promise((resolve) => {
    const [executable = "", ...leading] = prefix;
    const child = NodeChildProcess.spawn(executable, [...leading, ...args], {
      env: {
        ...process.env,
        CI: undefined,
        T3_HEAVY_GATE: undefined,
        T3_HEAVY_GATE_DISABLE: undefined,
        T3_HEAVY_GATE_HELD: undefined,
        T3_HEAVY_GATE_LOCK: env.GATE_DIR
          ? NodePath.join(env.GATE_DIR, "heavy-check.lock")
          : undefined,
        ...env,
      },
    });
    onSpawn(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });

// A stand-in for the dev VM's heavy-check: one flock slot on a heavy-check.lock
// held on fd 9 by the command it execs, and a line in $GATE_LOG per admission.
const fakeGateSource = `#!/bin/bash
set -eu
exec 9>"$GATE_DIR/heavy-check.lock"
flock -x 9
echo "admitted $$" >> "$GATE_DIR/log"
exec "$@"
`;

const withGateDir = async (body: (dir: string, gate: string) => Promise<void>): Promise<void> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-gate-"));
  const gate = NodePath.join(dir, "heavy-check");
  NodeFS.writeFileSync(gate, fakeGateSource, { mode: 0o755 });
  try {
    await body(dir, gate);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const admissions = (dir: string): number => {
  const log = NodePath.join(dir, "log");
  return NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n").length : 0;
};

const printEnvAndArgs = [
  "node",
  "-e",
  "console.log(JSON.stringify([process.argv.slice(1), Boolean(process.env.T3_HEAVY_GATE_HELD), process.env.T3_HEAVY_GATE_SUPERVISE ?? null]))",
  "a b",
  "--flag=1",
  "",
];

describe("heavy-gate", () => {
  it("runs the command directly when the gate executable is absent", async () => {
    const result = await run(printEnvAndArgs, { T3_HEAVY_GATE: "/nonexistent/heavy-check" });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), [["a b", "--flag=1", ""], false, null]);
  });

  it("preserves the exit status when the gate is absent", async () => {
    const result = await run(["node", "-e", "process.exit(7)"], {
      T3_HEAVY_GATE: "/nonexistent/heavy-check",
    });
    assert.strictEqual(result.status, 7);
  });

  it("exits 64 without a command", async () => {
    const result = await run([], {});
    assert.strictEqual(result.status, 64);
  });

  describe.skipIf(NodeOS.platform() !== "linux")("with a gate present", () => {
    it("takes the slot, marks the child as holding it, and preserves argv", async () => {
      await withGateDir(async (dir, gate) => {
        const result = await run(printEnvAndArgs, { T3_HEAVY_GATE: gate, GATE_DIR: dir });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.deepStrictEqual(JSON.parse(result.stdout), [["a b", "--flag=1", ""], true, null]);
        assert.strictEqual(admissions(dir), 1);
      });
    });

    it("preserves the exit status through the gate", async () => {
      await withGateDir(async (dir, gate) => {
        const result = await run(["node", "-e", "process.exit(9)"], {
          T3_HEAVY_GATE: gate,
          GATE_DIR: dir,
        });
        assert.strictEqual(result.status, 9);
        assert.strictEqual(admissions(dir), 1);
      });
    });

    it("skips the gate on CI, when disabled, and when the marker is set", async () => {
      await withGateDir(async (dir, gate) => {
        for (const bypass of [
          { CI: "true" },
          { T3_HEAVY_GATE_DISABLE: "1" },
          { T3_HEAVY_GATE_HELD: "1" },
        ]) {
          const result = await run(["node", "-e", "0"], {
            T3_HEAVY_GATE: gate,
            GATE_DIR: dir,
            ...bypass,
          });
          assert.strictEqual(result.status, 0, result.stderr);
        }
        assert.strictEqual(admissions(dir), 0);
      });
    });

    it("does not deadlock when a gated command runs another gated command", async () => {
      await withGateDir(async (dir, gate) => {
        const result = await run(
          [
            process.execPath,
            gateScript,
            process.execPath,
            gateScript,
            "node",
            "-e",
            "console.log('inner')",
          ],
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
        );
        assert.strictEqual(result.status, 0, result.stderr);
        assert.include(result.stdout, "inner");
        assert.strictEqual(admissions(dir), 1);
      });
    });

    it("does not deadlock under a caller that took the slot with heavy-check directly", async () => {
      await withGateDir(async (dir, gate) => {
        const result = await run(
          [process.execPath, gateScript, "node", "-e", "console.log('inner')"],
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
          20_000,
          () => {},
          [gate],
        );
        assert.strictEqual(result.status, 0, result.stderr);
        assert.include(result.stdout, "inner");
        assert.strictEqual(admissions(dir), 1);
      });
    });

    it("recognises a slot taken with heavy-check directly when the descendant does not inherit the fd", async () => {
      await withGateDir(async (dir, gate) => {
        const result = await run(
          [
            "bash",
            "-c",
            `"$0" "$@" 9>&-`,
            process.execPath,
            gateScript,
            "node",
            "-e",
            "console.log('inner')",
          ],
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
          20_000,
          () => {},
          [gate],
        );
        assert.strictEqual(result.status, 0, result.stderr);
        assert.include(result.stdout, "inner");
        assert.strictEqual(admissions(dir), 1);
      });
    });

    const detachedChild = (dir: string, label: string, ms: number): string[] => [
      "node",
      "-e",
      `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(
        `setTimeout(()=>require('fs').appendFileSync(${JSON.stringify(NodePath.join(dir, "events"))},${JSON.stringify(`${label}-child-done `)}+Date.now()+'\\n'),${ms})`,
      )}],{detached:true,stdio:'ignore'}).unref()`,
    ];

    it("keeps the slot until a detached child of the command has exited", async () => {
      await withGateDir(async (dir, gate) => {
        const first = run(detachedChild(dir, "a", 1200), { T3_HEAVY_GATE: gate, GATE_DIR: dir });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const second = run(
          [
            "node",
            "-e",
            `require('fs').appendFileSync(${JSON.stringify(NodePath.join(dir, "events"))},'b-start '+Date.now()+'\\n')`,
          ],
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
        );
        const results = await Promise.all([first, second]);
        for (const result of results) assert.strictEqual(result.status, 0, result.stderr);
        const events = Object.fromEntries(
          NodeFS.readFileSync(NodePath.join(dir, "events"), "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split(" ") as [string, string]),
        );
        assert.isAtLeast(Number(events["b-start"]), Number(events["a-child-done"]));
      });
    });

    it("releases the slot after the linger limit without killing the stragglers", async () => {
      await withGateDir(async (dir, gate) => {
        const result = await run(detachedChild(dir, "a", 2500), {
          T3_HEAVY_GATE: gate,
          GATE_DIR: dir,
          T3_HEAVY_GATE_LINGER_MS: "300",
        });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.include(result.stderr, "outlived it");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assert.include(NodeFS.readFileSync(NodePath.join(dir, "events"), "utf8"), "a-child-done");
      });
    });

    it("holds the slot for a daemonized child that closed fd 9 and called setsid", async () => {
      await withGateDir(async (dir, gate) => {
        const events = NodePath.join(dir, "events");
        const daemon = `setTimeout(()=>require('fs').appendFileSync(${JSON.stringify(events)},'a-child-done '+Date.now()+'\\n'),1200)`;
        const first = run(
          [
            "bash",
            "-c",
            `exec 9>&-; setsid -f ${JSON.stringify(process.execPath)} -e ${JSON.stringify(daemon)} </dev/null >/dev/null 2>&1`,
          ],
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        const second = run(
          [
            "node",
            "-e",
            `require('fs').appendFileSync(${JSON.stringify(events)},'b-start '+Date.now()+'\\n')`,
          ],
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
        );
        for (const result of await Promise.all([first, second])) {
          assert.strictEqual(result.status, 0, result.stderr);
        }
        const lines = NodeFS.readFileSync(events, "utf8").trim().split("\n");
        const at = (label: string) => Number(lines.find((l) => l.startsWith(label))?.split(" ")[1]);
        assert.isAtLeast(at("b-start"), at("a-child-done"));
      });
    });

    // A command that records its pid and that of a setsid'd daemon, then blocks.
    const treeUntilSignalled = (dir: string, daemonIgnoresTerm: boolean): string[] => [
      "node",
      "-e",
      `const cp=require('child_process'),fs=require('fs');
const d=cp.spawn(process.execPath,['-e',${JSON.stringify(
        `${daemonIgnoresTerm ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},1000)`,
      )}],{detached:true,stdio:'ignore'});d.unref();
fs.writeFileSync(${JSON.stringify(NodePath.join(dir, "pids"))},JSON.stringify([process.pid,d.pid]));
setInterval(()=>{},1000)`,
    ];

    const waitForFile = async (path: string): Promise<void> => {
      for (let i = 0; i < 100 && !NodeFS.existsSync(path); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it("terminates the whole tree, daemonized children included, when the gate is signalled", async () => {
      await withGateDir(async (dir, gate) => {
        let gateProcess: NodeChildProcess.ChildProcess | undefined;
        const running = run(
          treeUntilSignalled(dir, false),
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
          20_000,
          (child) => (gateProcess = child),
        );
        await waitForFile(NodePath.join(dir, "pids"));
        const [commandPid, daemonPid] = JSON.parse(
          NodeFS.readFileSync(NodePath.join(dir, "pids"), "utf8"),
        ) as [number, number];
        assert.isTrue(alive(commandPid) && alive(daemonPid));
        gateProcess?.kill("SIGTERM");
        const result = await running;
        assert.strictEqual(result.signal, "SIGTERM");
        for (let i = 0; i < 50 && alive(daemonPid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.isFalse(alive(commandPid));
        assert.isFalse(alive(daemonPid));
        const next = await run(["node", "-e", "0"], { T3_HEAVY_GATE: gate, GATE_DIR: dir }, 5_000);
        assert.strictEqual(next.status, 0);
      });
    });

    it("kills a descendant that ignores SIGTERM after the grace period", async () => {
      await withGateDir(async (dir, gate) => {
        let gateProcess: NodeChildProcess.ChildProcess | undefined;
        const running = run(
          treeUntilSignalled(dir, true),
          { T3_HEAVY_GATE: gate, GATE_DIR: dir, T3_HEAVY_GATE_KILL_GRACE_MS: "500" },
          20_000,
          (child) => (gateProcess = child),
        );
        await waitForFile(NodePath.join(dir, "pids"));
        const [, daemonPid] = JSON.parse(
          NodeFS.readFileSync(NodePath.join(dir, "pids"), "utf8"),
        ) as [number, number];
        gateProcess?.kill("SIGTERM");
        await running;
        for (let i = 0; i < 50 && alive(daemonPid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.isFalse(alive(daemonPid));
      });
    });

    it("returns the command's own status when it handles the signal", async () => {
      await withGateDir(async (dir, gate) => {
        let gateProcess: NodeChildProcess.ChildProcess | undefined;
        const running = run(
          [
            "node",
            "-e",
            `process.on('SIGINT',()=>process.exit(3));require('fs').writeFileSync(${JSON.stringify(NodePath.join(dir, "ready"))},'1');setInterval(()=>{},1000)`,
          ],
          { T3_HEAVY_GATE: gate, GATE_DIR: dir },
          20_000,
          (child) => (gateProcess = child),
        );
        await waitForFile(NodePath.join(dir, "ready"));
        gateProcess?.kill("SIGINT");
        const result = await running;
        assert.strictEqual(result.status, 3);
      });
    });

    it("serializes concurrent commands", async () => {
      await withGateDir(async (dir, gate) => {
        const interval = (label: string) => [
          "node",
          "-e",
          `const fs=require('fs');const t=()=>Date.now();const s=t();setTimeout(()=>{fs.appendFileSync(${JSON.stringify(NodePath.join(dir, "spans"))},JSON.stringify({label:${JSON.stringify(label)},s,e:t()})+'\\n')},400)`,
        ];
        const results = await Promise.all(
          ["a", "b", "c"].map((label) =>
            run(interval(label), { T3_HEAVY_GATE: gate, GATE_DIR: dir }),
          ),
        );
        for (const result of results) assert.strictEqual(result.status, 0, result.stderr);
        const spans = NodeFS.readFileSync(NodePath.join(dir, "spans"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { s: number; e: number })
          .toSorted((x, y) => x.s - y.s);
        assert.strictEqual(spans.length, 3);
        for (let i = 1; i < spans.length; i += 1) {
          assert.isAtLeast(spans[i]!.s, spans[i - 1]!.e);
        }
      });
    });
  });
});

describe("package scripts", () => {
  const packageDirs = [
    "scripts",
    ...["apps", "packages"].flatMap((group) =>
      NodeFS.readdirSync(NodePath.join(repoRoot, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${group}/${entry.name}`),
    ),
  ].filter((dir) => NodeFS.existsSync(NodePath.join(repoRoot, dir, "package.json")));

  it("take the heavy-check slot for every typecheck and vitest run", () => {
    const ungated: string[] = [];
    for (const dir of packageDirs) {
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(repoRoot, dir, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };
      const gate = NodePath.relative(NodePath.join(repoRoot, dir), gateScript);
      const expected = `node ${gate.startsWith(".") ? gate : `./${gate}`} `;
      for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
        const heavy = name === "typecheck" || (name === "test" && script.includes("vp test run"));
        if (heavy && !script.startsWith(expected)) ungated.push(`${dir}: ${name}`);
      }
    }
    assert.deepStrictEqual(ungated, []);
  });
});
