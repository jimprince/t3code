#!/usr/bin/env node

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

interface CliArgs {
  readonly artifact: string;
  readonly version: string;
  readonly skipServe: boolean;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

type SmokeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const usage = `Usage: node scripts/smoke-headless-artifact.ts --artifact <tar.gz> --version <version> [--skip-serve]`;

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let artifact: string | undefined;
  let version: string | undefined;
  let skipServe = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact") {
      artifact = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--version") {
      version = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--skip-serve") {
      skipServe = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ""}\n${usage}`);
  }

  if (!artifact || !version) {
    throw new Error(usage);
  }

  return { artifact, version, skipServe };
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        timeout: 20_000,
        env: {
          ...process.env,
          T3CODE_LOG_LEVEL: "Error",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Command failed: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function findExtractedRoot(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) {
    throw new Error(
      `Expected exactly one extracted artifact directory, found ${directories.length}.`,
    );
  }

  const dirname = directories[0]?.name;
  if (!dirname) {
    throw new Error("Extracted artifact directory is missing a name.");
  }
  return path.join(extractDir, dirname);
}

function requestHttp200(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(url, (response) => {
      response.resume();
      settle(response.statusCode === 200);
    });
    request.setTimeout(1_000, () => {
      request.destroy();
      settle(false);
    });
    request.on("error", () => settle(false));
  });
}

async function waitForHttp200(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await requestHttp200(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for HTTP 200 from ${url}.`);
}

function collectProcessOutput(child: SmokeChildProcess): () => string {
  let stdout = "";
  let stderr = "";
  const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
    if (kind === "stdout") {
      stdout += chunk.toString("utf8");
      stdout = stdout.slice(-12_000);
    } else {
      stderr += chunk.toString("utf8");
      stderr = stderr.slice(-12_000);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  return () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
}

async function stopChild(child: SmokeChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function findAvailablePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Unable to resolve test server port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function smokeServe(artifactRoot: string, entrypoint: string): Promise<void> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "t3-headless-base-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t3-headless-workspace-"));
  const port = await findAvailablePort();
  const child = spawn(
    entrypoint,
    [
      "serve",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
      "--base-dir",
      baseDir,
      workspaceDir,
    ],
    {
      cwd: artifactRoot,
      env: {
        ...process.env,
        T3CODE_LOG_LEVEL: "Error",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = collectProcessOutput(child);

  try {
    await Promise.race([
      waitForHttp200(`http://127.0.0.1:${port}/`, 30_000),
      new Promise<never>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(`Server exited before HTTP smoke passed (${code ?? signal}).\n${output()}`),
          );
        });
      }),
    ]);
  } finally {
    await stopChild(child);
    await rm(baseDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extractDir = await mkdtemp(path.join(os.tmpdir(), "t3-headless-artifact-"));

  try {
    await runCommand("tar", ["-xzf", args.artifact, "-C", extractDir]);
    const artifactRoot = await findExtractedRoot(extractDir);
    const entrypoint = path.join(artifactRoot, "bin/t3");

    const versionResult = await runCommand(entrypoint, ["--version"], artifactRoot);
    if (!versionResult.stdout.includes(args.version)) {
      throw new Error(
        `Expected --version output to include '${args.version}', got:\n${versionResult.stdout}`,
      );
    }

    const helpResult = await runCommand(entrypoint, ["--help"], artifactRoot);
    if (!helpResult.stdout.includes("USAGE")) {
      throw new Error(`Expected --help output to include USAGE, got:\n${helpResult.stdout}`);
    }

    if (!args.skipServe) {
      await smokeServe(artifactRoot, entrypoint);
    }

    console.log(`Headless artifact smoke passed for ${path.basename(args.artifact)}.`);
  } finally {
    await mkdir(extractDir, { recursive: true });
    await rm(extractDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
