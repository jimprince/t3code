import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
const exec = promisify(execFile);
it("reports missing shell identity and accepts MCP-provided command-local identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-caller-"));
  try {
    const base = {
      ...process.env,
      T3_AGENT_STATE_FILE: join(directory, "state.json"),
      T3_THREAD_ID: "",
      T3_ENVIRONMENT_ID: "",
      T3_ENVIRONMENT_NAME: "",
    };
    const run = async (env: NodeJS.ProcessEnv) =>
      JSON.parse(
        (
          await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "caller"], {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            env,
            timeout: 60_000,
          })
        ).stdout,
      );
    expect(await run(base)).toMatchObject({
      status: "identity-unavailable",
      caller: { status: "identity-unavailable" },
      identityTool: "t3_worker_identity",
    });
    expect(
      await run({
        ...base,
        T3_THREAD_ID: "scoped-thread",
        T3_ENVIRONMENT_ID: "environment",
        T3_ENVIRONMENT_NAME: "Development",
      }),
    ).toMatchObject({
      status: "available",
      threadId: "scoped-thread",
      caller: { environment: "Development", saved: false },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
