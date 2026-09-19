// @effect-diagnostics nodeBuiltinImport:off -- The OS-app handoff is an imperative boundary with injected dependencies for focused tests.
import {
  DESKTOP_MODEL_HANDOFF_MAX_BYTES,
  type DesktopOpenModelInOrcaSlicerResult,
} from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export type OrcaSlicerHandoffDependencies = {
  readonly platform: NodeJS.Platform;
  readonly tempDirectory: string;
  readonly makeTempDirectory: (prefix: string) => Promise<string>;
  readonly writeFile: (
    path: string,
    bytes: Uint8Array,
    options: { readonly flag: "wx"; readonly mode: number },
  ) => Promise<void>;
  readonly removeDirectory: (path: string) => Promise<void>;
  readonly launch: (executable: string, args: readonly string[]) => Promise<void>;
};

export function nodeOrcaSlicerHandoffDependencies(
  platform: NodeJS.Platform,
): OrcaSlicerHandoffDependencies {
  return {
    platform,
    tempDirectory: NodeOS.tmpdir(),
    makeTempDirectory: (prefix) => NodeFSP.mkdtemp(prefix),
    writeFile: (path, bytes, options) => NodeFSP.writeFile(path, bytes, options),
    removeDirectory: (path) => NodeFSP.rm(path, { recursive: true, force: true }),
    launch: async (executable, args) => {
      await execFile(executable, args);
    },
  };
}

export function safeModelFileName(rawName: string): string | null {
  const extension = /\.(stl|3mf|step|stp)$/i.exec(rawName)?.[1]?.toLowerCase();
  if (!extension) return null;
  const basename =
    rawName
      .split(/[\\/]/)
      .at(-1)
      ?.slice(0, -(extension.length + 1))
      .trim() ?? "";
  const stem = basename
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .slice(0, 120)
    .trim();
  return `${stem || "model"}.${extension}`;
}

export async function openModelInOrcaSlicer(
  input: { readonly name: string; readonly bytes: Uint8Array },
  dependencies: OrcaSlicerHandoffDependencies,
): Promise<DesktopOpenModelInOrcaSlicerResult> {
  const fileName = safeModelFileName(input.name);
  if (fileName === null) {
    return {
      opened: false,
      error: "OrcaSlicer handoff supports STL, 3MF, and STEP files only.",
    };
  }
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > DESKTOP_MODEL_HANDOFF_MAX_BYTES) {
    return { opened: false, error: "The model file is empty or exceeds the 50 MB handoff limit." };
  }
  if (dependencies.platform !== "darwin") {
    return {
      opened: false,
      error: "Open in OrcaSlicer is currently available in T3 Code Desktop on macOS.",
    };
  }

  let stagingDirectory: string | undefined;
  let stagedPath: string;
  try {
    stagingDirectory = await dependencies.makeTempDirectory(
      NodePath.join(dependencies.tempDirectory, "t3-orcaslicer-"),
    );
    stagedPath = NodePath.join(stagingDirectory, fileName);
    await dependencies.writeFile(stagedPath, input.bytes, { flag: "wx", mode: 0o600 });
  } catch {
    if (stagingDirectory !== undefined) {
      await dependencies.removeDirectory(stagingDirectory).catch(() => undefined);
    }
    return { opened: false, error: "The model file could not be prepared for OrcaSlicer." };
  }

  try {
    await dependencies.launch("/usr/bin/open", ["-a", "OrcaSlicer", stagedPath]);
    return { opened: true };
  } catch {
    await dependencies.removeDirectory(stagingDirectory).catch(() => undefined);
    return {
      opened: false,
      error: "OrcaSlicer could not be opened. Install OrcaSlicer in Applications and try again.",
    };
  }
}
