#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { smokeThreadHistory } from "./smoke-thread-history.ts";

const archive = process.argv[2];
NodeAssert.ok(archive, "Usage: node scripts/smoke-desktop-history.ts <macOS-arm64.zip>");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-history-"));
try {
  NodeChildProcess.execFileSync("ditto", ["-x", "-k", NodePath.resolve(archive), root], {
    timeout: 60_000,
  });
  const apps = (await NodeFSP.readdir(root)).filter((entry) => entry.endsWith(".app"));
  NodeAssert.equal(apps.length, 1, "Expected one packaged application");
  const contents = NodePath.join(root, apps[0]!, "Contents");
  const executables = await NodeFSP.readdir(NodePath.join(contents, "MacOS"));
  NodeAssert.equal(executables.length, 1, "Expected one Electron executable");
  await smokeThreadHistory(
    [
      NodePath.join(contents, "MacOS", executables[0]!),
      NodePath.join(contents, "Resources/app.asar/apps/server/dist/bin.mjs"),
    ],
    root,
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
