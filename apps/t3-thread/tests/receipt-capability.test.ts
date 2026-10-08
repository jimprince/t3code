import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { RemoteEnvironmentClient } from "../src/client.js";
import { descriptorFixture } from "./descriptor-fixture.js";
import type { SavedEnvironment } from "../src/types.js";

it("explains target version skew without dispatch and retains the send identity", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "receipt-capability-"));
  const old = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
  const environment: SavedEnvironment = {
    name: "local-mbp",
    httpBaseUrl: "http://fixture.invalid",
    wsBaseUrl: "ws://fixture.invalid",
    environmentId: "fixture",
    label: "Mac",
    serverVersion: "cached-newer-version",
    bearerToken: "fixture",
    expiresAt: "2099-01-01T00:00:00Z",
    pairedAt: "2026-10-07T00:00:00Z",
  };
  const rpcFactory = vi.fn();
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      serverVersion: "fork.3",
      capabilities: {},
    }),
    rpcFactory,
  });
  try {
    const input = { threadId: "recipient", text: "private message", commandId: "same-send" };
    const result = await client.sendMessage(input);
    expect(result).toMatchObject({
      dispatched: false,
      queued: false,
      uncertain: false,
      sendId: "same-send",
      causeCode: "RECEIPTS_UNAVAILABLE",
      targetServerVersion: "fork.3",
    });
    expect(result.message).toContain("local-mbp");
    expect(result.message).toContain("capabilities.reliableHandoffs=true");
    expect(result.message).toContain("Update the target app/server");
    expect(result.message).toContain("same send ID same-send");
    expect(JSON.stringify(result)).not.toContain("private message");
    expect(await client.sendMessage(input)).toEqual(result);
    expect(rpcFactory).not.toHaveBeenCalled();
  } finally {
    if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = old;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
