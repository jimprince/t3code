import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { CLI_ERROR_MESSAGE_LIMIT, formatCliError } from "../src/errorOutput.js";

const workspaceRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

/** Serves an oversized non-JSON error body, the shape that floods the CLI. */
async function withFloodingServer(test: (baseUrl: string) => Promise<void>): Promise<void> {
  const body = `remote failure: ${"x".repeat(200_000)}`;
  const server = NodeHttp.createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address for the stub server.");
  }

  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function runCli(
  args: ReadonlyArray<string>,
  stateFile: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = NodeChildProcess.spawn(
    NodePath.join(workspaceRoot, "node_modules/.bin/tsx"),
    ["src/cli.ts", ...args],
    {
      cwd: workspaceRoot,
      env: { ...process.env, T3_AGENT_STATE_FILE: stateFile },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

describe("CLI error output", () => {
  it("bounds an oversized remote failure instead of dumping the whole payload", async () => {
    const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-cli-error-"));
    try {
      await withFloodingServer(async (baseUrl) => {
        const result = await runCli(
          ["pair", "--name", "probe", "--host", baseUrl, "--credential", "probe-code"],
          NodePath.join(tempDir, "state.json"),
        );

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("remote failure:");
        expect(result.stderr).toContain("truncated");
        expect(result.stderr.length).toBeLessThan(CLI_ERROR_MESSAGE_LIMIT * 2);
      });
    } finally {
      await NodeFSP.rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves a message that already fits untouched", () => {
    expect(formatCliError(new Error("boom"))).toBe("boom");
    expect(formatCliError("plain string failure")).toBe("plain string failure");
  });
});
