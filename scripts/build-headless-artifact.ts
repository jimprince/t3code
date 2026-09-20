#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This archive adapter uses Node filesystem and subprocess APIs at the build boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { cliArchiveFileName, cliArchiveStem } from "./build-cli-archive.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";

const PLATFORM = "linux" as const;
const ARCH = "x64" as const;

/**
 * node_modules the upstream CLI archive must carry: the server dependencies
 * upstream keeps external to its single-executable bundle. Derived from the
 * same list upstream stages from, so the check follows upstream when a native
 * package is added or dropped (msgpackr-extract left in 2005).
 */
export function headlessRuntimeExternalPaths(): string[] {
  return Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies))
    .sort()
    .map((name) => `node_modules/${name}`);
}

interface CliArgs {
  readonly version: string;
  readonly outputDir: string;
  readonly resourceMonitorDir: string | undefined;
  readonly upstreamArchive: string | undefined;
}

export function resolveHeadlessArtifactBaseName(version: string): string {
  return `t3-headless-${version}-${PLATFORM}-${ARCH}`;
}

export function resolveHeadlessArtifactName(version: string): string {
  return `${resolveHeadlessArtifactBaseName(version)}.tar.gz`;
}

export const HEADLESS_ENTRYPOINT = `#!/bin/sh
set -eu
case "$0" in
  */*) script_dir=\${0%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
exec "$script_dir/../t3" "$@"
`;

function run(command: string, args: ReadonlyArray<string>, cwd?: string): void {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}.`);
  }
}

async function requirePath(path: string): Promise<void> {
  try {
    await NodeFSP.access(path);
  } catch (cause) {
    throw new Error(`Upstream CLI archive is missing ${path}.`, { cause });
  }
}

async function requireOneOf(root: string, candidates: ReadonlyArray<string>): Promise<void> {
  for (const candidate of candidates) {
    try {
      await NodeFSP.access(NodePath.join(root, candidate));
      return;
    } catch {
      // Try the next supported upstream layout.
    }
  }
  throw new Error(`Upstream CLI archive is missing ${candidates.join(" or ")}.`);
}

/** Adds only the fork's stable asset name and installed bin/t3 path. */
export async function adaptCliArchive(input: {
  readonly archive: string;
  readonly outputDir: string;
  readonly version: string;
}): Promise<string> {
  const stageRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-headless-adapter-"));
  try {
    run("tar", ["-xzf", input.archive, "-C", stageRoot]);
    const upstreamRoot = NodePath.join(stageRoot, cliArchiveStem(input.version, PLATFORM, ARCH));
    for (const required of [
      "t3",
      "client/index.html",
      ...headlessRuntimeExternalPaths(),
    ]) {
      await requirePath(NodePath.join(upstreamRoot, required));
    }
    await requireOneOf(upstreamRoot, [
      "resource-monitor/linux-x64/t3-resource-monitor",
      "resource-monitor/t3-resource-monitor",
    ]);

    const binDir = NodePath.join(upstreamRoot, "bin");
    await NodeFSP.mkdir(binDir, { recursive: true });
    const entrypoint = NodePath.join(binDir, "t3");
    await NodeFSP.writeFile(entrypoint, HEADLESS_ENTRYPOINT, { mode: 0o755 });

    const artifactRoot = NodePath.join(stageRoot, resolveHeadlessArtifactBaseName(input.version));
    await NodeFSP.rename(upstreamRoot, artifactRoot);
    await NodeFSP.mkdir(input.outputDir, { recursive: true });
    const artifact = NodePath.join(input.outputDir, resolveHeadlessArtifactName(input.version));
    await NodeFSP.rm(artifact, { force: true });
    run("tar", ["-czf", artifact, "-C", stageRoot, NodePath.basename(artifactRoot)]);
    return artifact;
  } finally {
    await NodeFSP.rm(stageRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let version = serverPackageJson.version;
  let outputDir = "release";
  let resourceMonitorDir: string | undefined;
  let upstreamArchive: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === "--build-version" ||
      flag === "--output-dir" ||
      flag === "--resource-monitor-dir" ||
      flag === "--upstream-archive"
    ) {
      if (!value) throw new Error(`Missing value for ${flag}.`);
      if (flag === "--build-version") version = value;
      if (flag === "--output-dir") outputDir = value;
      if (flag === "--resource-monitor-dir") resourceMonitorDir = value;
      if (flag === "--upstream-archive") upstreamArchive = value;
      index += 1;
      continue;
    }
    if (flag === "--platform" && value === PLATFORM) {
      index += 1;
      continue;
    }
    if (flag === "--arch" && value === ARCH) {
      index += 1;
      continue;
    }
    throw new Error(`Unsupported headless build argument: ${flag ?? ""}`);
  }
  return { version, outputDir, resourceMonitorDir, upstreamArchive };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  const outputDir = NodePath.resolve(repoRoot, args.outputDir);
  const upstreamOutput = args.upstreamArchive
    ? undefined
    : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-archive-output-"));
  try {
    const upstreamArchive = args.upstreamArchive
      ? NodePath.resolve(args.upstreamArchive)
      : NodePath.join(upstreamOutput!, cliArchiveFileName(args.version, PLATFORM, ARCH));
    if (!args.upstreamArchive) {
      const buildArgs = [
        "scripts/build-cli-archive.ts",
        "--platform",
        PLATFORM,
        "--arch",
        ARCH,
        "--version",
        args.version,
        "--output-dir",
        upstreamOutput!,
      ];
      if (args.resourceMonitorDir) {
        buildArgs.push("--resource-monitor-dir", args.resourceMonitorDir);
      }
      run(process.execPath, buildArgs, repoRoot);
    }
    const artifact = await adaptCliArchive({
      archive: upstreamArchive,
      outputDir,
      version: args.version,
    });
    process.stdout.write(`[headless-artifact] Wrote ${artifact}\n`);
  } finally {
    if (upstreamOutput) await NodeFSP.rm(upstreamOutput, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
