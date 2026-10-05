// @effect-diagnostics nodeBuiltinImport:off - Exercises real archive files and launcher subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { cliArchiveStem } from "./build-cli-archive.ts";
import {
  adaptCliArchive,
  HEADLESS_ENTRYPOINT,
  headlessRuntimeExternalPaths,
  resolveHeadlessArtifactName,
} from "./build-headless-artifact.ts";

const VERSION = "0.0.23-nightly.20260506.217-fork.1";

describe("build-headless-artifact", () => {
  it("preserves the published Linux x64 asset name", () => {
    expect(resolveHeadlessArtifactName(VERSION)).toBe(`t3-headless-${VERSION}-linux-x64.tar.gz`);
  });

  it("uses a Node-free compatibility entrypoint", () => {
    expect(HEADLESS_ENTRYPOINT).toContain('exec "$script_dir/../t3" "$@"');
    expect(HEADLESS_ENTRYPOINT).not.toMatch(/\bnode\b/);
  });

  it("adapts the upstream archive and runs bin/t3 without Node on PATH", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "headless-adapter-test-"));
    try {
      const upstreamRoot = NodePath.join(scratch, cliArchiveStem(VERSION, "linux", "x64"));
      await NodeFSP.mkdir(NodePath.join(upstreamRoot, "client"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(upstreamRoot, "resource-monitor/linux-x64"), {
        recursive: true,
      });
      for (const required of headlessRuntimeExternalPaths()) {
        await NodeFSP.mkdir(NodePath.join(upstreamRoot, required), { recursive: true });
      }
      await NodeFSP.writeFile(
        NodePath.join(upstreamRoot, "t3"),
        `#!/bin/sh
case "\${1:-}" in
  --version) printf 'T3 Code ${VERSION}\\n' ;;
  --help) printf 'USAGE: t3 [command]\\n' ;;
esac
`,
        { mode: 0o755 },
      );
      await NodeFSP.writeFile(NodePath.join(upstreamRoot, "client/index.html"), "<main>T3</main>");
      await NodeFSP.writeFile(
        NodePath.join(upstreamRoot, "resource-monitor/linux-x64/t3-resource-monitor"),
        "monitor",
      );
      const upstreamArchive = NodePath.join(scratch, "upstream.tar.gz");
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        upstreamArchive,
        "-C",
        scratch,
        NodePath.basename(upstreamRoot),
      ]);

      const outputDir = NodePath.join(scratch, "output");
      const artifact = await adaptCliArchive({
        archive: upstreamArchive,
        outputDir,
        version: VERSION,
      });
      const smoke = NodeChildProcess.spawnSync(
        process.execPath,
        [
          NodePath.join(import.meta.dirname, "smoke-headless-artifact.ts"),
          "--artifact",
          artifact,
          "--version",
          VERSION,
          "--skip-serve",
        ],
        { encoding: "utf8" },
      );
      const extractDir = NodePath.join(scratch, "extract");
      await NodeFSP.mkdir(extractDir);
      NodeChildProcess.execFileSync("tar", ["-xzf", artifact, "-C", extractDir]);
      const root = NodePath.join(extractDir, `t3-headless-${VERSION}-linux-x64`);
      const result = NodeChildProcess.spawnSync(NodePath.join(root, "bin/t3"), ["--version"], {
        cwd: root,
        env: { PATH: "" },
        encoding: "utf8",
      });

      expect(smoke.status, smoke.stderr).toBe(0);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(VERSION);
      expect((await NodeFSP.lstat(NodePath.join(root, "t3"))).isSymbolicLink()).toBe(false);
      await expect(NodeFSP.stat(NodePath.join(root, "client/index.html"))).resolves.toBeDefined();
      await expect(
        NodeFSP.stat(NodePath.join(root, "node_modules/node-pty")),
      ).resolves.toBeDefined();
    } finally {
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("headlessRuntimeExternalPaths", () => {
  it("follows the server's runtime-external dependencies, not a fixed list", () => {
    const paths = headlessRuntimeExternalPaths();
    expect(paths).toContain("node_modules/node-pty");
    expect(paths).toContain("node_modules/@ff-labs/fff-node");
    expect(paths).not.toContain("node_modules/msgpackr-extract");
  });
});
