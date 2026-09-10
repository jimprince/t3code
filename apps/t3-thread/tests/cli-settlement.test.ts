import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const threadId = "22222222-2222-4222-8222-222222222222";

describe("settlement command registration and caller identity", () => {
  it.each([
    ["settle", threadId],
    ["agent", "settle", "self-alias"],
  ])("blocks the calling thread through %j", async (...args) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-settle-"));
    const stateFile = NodePath.join(directory, "state.json");
    try {
      await NodeFSP.writeFile(
        stateFile,
        JSON.stringify({
          version: 1,
          environments: [{ name: "offline", httpBaseUrl: "http://127.0.0.1:1" }],
          agents: [
            {
              name: "self-alias",
              threadId,
              environment: "offline",
              projectId: "project",
              title: "Self",
            },
          ],
          subscriptions: [],
          notifications: [],
          queuedSends: [],
        }),
      );
      await expect(
        execFile(NodePath.join(workspace, "node_modules/.bin/tsx"), ["src/cli.ts", ...args], {
          cwd: workspace,
          env: { ...process.env, T3_THREAD_ID: threadId, T3_AGENT_STATE_FILE: stateFile },
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Refusing to settle the calling thread"),
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
