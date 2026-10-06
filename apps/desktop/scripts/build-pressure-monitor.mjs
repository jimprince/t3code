#!/usr/bin/env node
// oxlint-disable t3code/no-global-process-runtime -- Standalone native build script has no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const sourceDir = NodePath.resolve(import.meta.dirname, "../native/pressure-monitor");
const outputFlagIndex = process.argv.indexOf("--output");
const outputPath =
  outputFlagIndex >= 0 && process.argv[outputFlagIndex + 1]
    ? NodePath.resolve(process.argv[outputFlagIndex + 1])
    : NodePath.resolve(import.meta.dirname, "../resources/T3PressureMonitor");
const archFlagIndex = process.argv.indexOf("--arch");
const requestedArch =
  archFlagIndex >= 0 && process.argv[archFlagIndex + 1]
    ? process.argv[archFlagIndex + 1]
    : process.arch === "x64"
      ? "x64"
      : "arm64";

if (process.platform !== "darwin") {
  process.exit(0);
}

const buildDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pressure-monitor-"));
try {
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  const buildArch = async (arch) => {
    const clangArch = arch === "x64" ? "x86_64" : "arm64";
    const target = `${clangArch}-apple-macos13.0`;
    const objectPath = NodePath.resolve(buildDir, `T3ProcessSampler-${arch}.o`);
    const binaryPath = NodePath.resolve(buildDir, `T3PressureMonitor-${arch}`);
    await execFileAsync("xcrun", [
      "clang",
      "-O2",
      "-arch",
      clangArch,
      "-target",
      target,
      "-c",
      NodePath.resolve(sourceDir, "T3ProcessSampler.c"),
      "-o",
      objectPath,
    ]);
    await execFileAsync("xcrun", [
      "swiftc",
      "-O",
      "-target",
      target,
      "-framework",
      "AppKit",
      "-import-objc-header",
      NodePath.resolve(sourceDir, "T3ProcessSampler.h"),
      NodePath.resolve(sourceDir, "main.swift"),
      objectPath,
      "-o",
      binaryPath,
    ]);
    return binaryPath;
  };

  if (requestedArch === "universal") {
    const [arm64Binary, x64Binary] = await Promise.all([buildArch("arm64"), buildArch("x64")]);
    await execFileAsync("xcrun", [
      "lipo",
      "-create",
      arm64Binary,
      x64Binary,
      "-output",
      outputPath,
    ]);
  } else {
    const binaryPath = await buildArch(requestedArch);
    await execFileAsync("/bin/cp", [binaryPath, outputPath]);
  }
} finally {
  await NodeFSP.rm(buildDir, { recursive: true, force: true });
}
