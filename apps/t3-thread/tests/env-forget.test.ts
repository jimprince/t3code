import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const directories: string[] = [];

function environment(name: string) {
  return {
    name,
    environmentId: "same-server",
    label: name,
    httpBaseUrl: "http://127.0.0.1:1",
    wsBaseUrl: "ws://127.0.0.1:1",
    bearerToken: "expired-test-token",
    expiresAt: "2000-01-01T00:00:00Z",
    pairedAt: "2000-01-01T00:00:00Z",
    serverVersion: "test",
  };
}

async function fixture(references = false) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-env-forget-"));
  directories.push(directory);
  const stateFile = NodePath.join(directory, "state.json");
  const state = {
    version: 1,
    environments: [environment("stale"), environment("keep")],
    agents: references
      ? [
          { name: "worker", environment: "stale" },
          { name: "other", environment: "keep" },
        ]
      : [],
    subscriptions: references
      ? [
          { sourceEnvironment: "stale", subscriberEnvironment: "keep" },
          { sourceEnvironment: "keep", subscriberEnvironment: "stale" },
          { sourceEnvironment: "keep", subscriberEnvironment: "keep" },
        ]
      : [],
    notifications: references
      ? [
          { sourceEnvironment: "stale", subscriberEnvironment: "keep", status: "pending" },
          { sourceEnvironment: "keep", subscriberEnvironment: "stale", status: "delivered" },
          { sourceEnvironment: "keep", subscriberEnvironment: "keep", status: "pending" },
        ]
      : [],
    queuedSends: references
      ? [
          { environment: "stale", status: "queued", text: "old" },
          { environment: "keep", status: "queued", text: "preserve" },
        ]
      : [],
  };
  await NodeFSP.writeFile(stateFile, JSON.stringify(state));
  return {
    state,
    read: async () => JSON.parse(await NodeFSP.readFile(stateFile, "utf8")),
    raw: () => NodeFSP.readFile(stateFile, "utf8"),
    run: (...args: string[]) =>
      execute(NodePath.join(workspace, "node_modules/.bin/tsx"), ["src/cli.ts", ...args], {
        cwd: workspace,
        env: { ...process.env, T3_AGENT_STATE_FILE: stateFile },
      }),
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("env forget", () => {
  it("forgets an expired offline pairing and preserves another alias of the same server", async () => {
    const f = await fixture();
    const result = await f.run("env", "forget", "stale");
    expect(JSON.parse(result.stdout)).toEqual({
      environment: "stale",
      forgotten: true,
      removed: { agents: 0, subscriptions: 0, notifications: 0, queuedSends: 0 },
    });
    expect(await f.read()).toEqual({ ...f.state, environments: [f.state.environments[1]] });
    expect(
      JSON.parse((await f.run("envs")).stdout).map((item: { name: string }) => item.name),
    ).toEqual(["keep"]);
  });

  it("refuses dependent state without force and leaves the file unchanged", async () => {
    const f = await fixture(true);
    const before = await f.raw();
    await expect(f.run("env", "forget", "stale")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Use --force"),
    });
    expect(await f.raw()).toBe(before);
  });

  it("force removes references in both directions including unsaved routes and queued sends", async () => {
    const f = await fixture(true);
    const result = await f.run("env", "forget", "stale", "--force");
    expect(JSON.parse(result.stdout).removed).toEqual({
      agents: 1,
      subscriptions: 2,
      notifications: 2,
      queuedSends: 1,
    });
    expect(await f.read()).toEqual({
      ...f.state,
      environments: [f.state.environments[1]],
      agents: [f.state.agents[1]],
      subscriptions: [f.state.subscriptions[2]],
      notifications: [f.state.notifications[2]],
      queuedSends: [f.state.queuedSends[1]],
    });
  });

  it("rejects unknown names even with force without changing state", async () => {
    const f = await fixture(true);
    const before = await f.raw();
    await expect(f.run("env", "forget", "missing", "--force")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown environment 'missing'"),
    });
    expect(await f.raw()).toBe(before);
  });
});
