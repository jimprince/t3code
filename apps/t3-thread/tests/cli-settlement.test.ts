import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

import { describeSubscriptionsOf } from "../src/state.js";
import type { StateFile } from "../src/types.js";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const threadId = "22222222-2222-4222-8222-222222222222";

function subscriptionState(): StateFile {
  const route = (sourceThreadId: string, sourceAgentName: string | null) => ({
    subscriberThreadId: threadId,
    subscriberAgentName: "orchestrator",
    subscriberEnvironment: "offline",
    sourceThreadId,
    sourceAgentName,
    sourceEnvironment: "offline",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  });
  const state: StateFile = {
    version: 1,
    environments: [],
    agents: [],
    // An unsaved source is named only by its thread id.
    subscriptions: [route("source-unsaved", null), route("source-kept", "kept")],
    notifications: [],
    queuedSends: [],
  };
  return state;
}

describe("settlement command registration and caller identity", () => {
  it.each([
    ["settle", threadId],
    ["agent", "settle", "self-alias"],
  ])(
    "blocks the calling thread through %j",
    async (...args) => {
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
    },
    15_000,
  );
});

describe("subscriptions listed by settle", () => {
  it.each([
    [
      ["--subscriber", threadId],
      ["source-unsaved", "source-kept"],
    ],
    [["--subscriber", "orchestrator", "--source", "source-unsaved"], ["source-unsaved"]],
    [["--source", "kept"], ["source-kept"]],
  ] as const)(
    "filters persisted subscriptions through %j",
    async (filters, expectedSources) => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-routes-"));
      const stateFile = NodePath.join(directory, "state.json");
      const env = { ...process.env, T3_AGENT_STATE_FILE: stateFile };
      delete env.T3_THREAD_ID;
      try {
        await NodeFSP.writeFile(stateFile, JSON.stringify(subscriptionState()));
        const result = await execFile(
          NodePath.join(workspace, "node_modules/.bin/tsx"),
          ["src/cli.ts", "subscriptions", ...filters],
          { cwd: workspace, env },
        );
        expect(
          JSON.parse(result.stdout).map(
            (route: { sourceThreadId: string }) => route.sourceThreadId,
          ),
        ).toEqual(expectedSources);
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("prints an unsubscribe command that works from any thread", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-unsub-"));
    const stateFile = NodePath.join(directory, "state.json");
    const state = subscriptionState();
    try {
      await NodeFSP.writeFile(stateFile, JSON.stringify(state));
      const [listed] = describeSubscriptionsOf(state, threadId);
      const [, ...args] = listed!.unsubscribe.split(" ");
      const env: NodeJS.ProcessEnv = { ...process.env, T3_AGENT_STATE_FILE: stateFile };
      delete env.T3_THREAD_ID;

      const { stdout } = await execFile(
        NodePath.join(workspace, "node_modules/.bin/tsx"),
        ["src/cli.ts", ...args],
        { cwd: workspace, env },
      );

      expect(JSON.parse(stdout)).toMatchObject({ removed: true, sourceThreadId: "source-unsaved" });
      const saved = JSON.parse(await NodeFSP.readFile(stateFile, "utf8")) as StateFile;
      expect(saved.subscriptions.map((subscription) => subscription.sourceThreadId)).toEqual([
        "source-kept",
      ]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
