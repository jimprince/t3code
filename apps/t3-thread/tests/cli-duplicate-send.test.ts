import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { RunId, ThreadId, type HandoffReceipt } from "@t3tools/contracts";
import { duplicateSendHash } from "../src/duplicateSend.js";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const threadId = "22222222-2222-4222-8222-222222222222";
const held: HandoffReceipt = {
  sendId: "original",
  recipientThreadId: ThreadId.make(threadId),
  acceptedAt: "2026-10-15T23:35:00.000Z",
  status: "held",
  cause: null,
  ownerThreadId: null,
};
const started: HandoffReceipt = {
  ...held,
  status: "started",
  run: {
    runId: RunId.make("run-2"),
    status: "running",
    terminal: false,
    queueHeld: false,
    requestedAt: "2026-10-16T02:32:42.954Z",
    startedAt: "2026-10-16T02:32:48.328Z",
    completedAt: null,
  },
};

async function sendCommand(
  options: {
    flags?: string[];
    current?: HandoffReceipt;
    unavailable?: boolean;
    cached?: boolean;
  } = {},
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cli-duplicate-"));
  vi.stubEnv("T3_AGENT_STATE_FILE", NodePath.join(directory, "state.json"));
  vi.stubEnv("T3_THREAD_ID", "");
  vi.stubEnv("T3_ENVIRONMENT_ID", "");
  vi.stubEnv("T3_ENVIRONMENT_NAME", "");
  vi.resetModules();
  const { saveState } = await import("../src/state.js");
  await saveState({
    version: 1,
    environments: [
      {
        name: "local",
        httpBaseUrl: "http://127.0.0.1:1",
        wsBaseUrl: "ws://127.0.0.1:1",
        environmentId: "local",
        label: "Local",
        serverVersion: "test",
        bearerToken: "test",
        expiresAt: "2099-01-01T00:00:00Z",
        pairedAt: held.acceptedAt,
      },
    ],
    agents: [
      {
        name: "worker",
        threadId,
        environment: "local",
        projectId: "project",
        title: "Worker",
        createdAt: held.acceptedAt,
        lastSeenAssistantMessageId: null,
      },
    ],
    subscriptions: [],
    notifications: [],
    queuedSends: [],
  });
  await NodeFSP.mkdir(NodePath.join(directory, "send-intents"));
  await NodeFSP.writeFile(
    NodePath.join(directory, "send-intents/original.json"),
    JSON.stringify({
      sendId: "original",
      recipientThreadId: threadId,
      environment: "local",
      createdAt: held.acceptedAt,
      duplicateSend: {
        hash: duplicateSendHash(threadId, "continue the follow-up"),
        senderThreadId: null,
      },
      ...(options.cached === false ? {} : { receipt: held }),
    }),
  );
  if (options.flags?.includes("--send-id")) {
    await NodeFSP.writeFile(
      NodePath.join(directory, "send-intents/z-forced.json"),
      JSON.stringify({
        sendId: "z-forced",
        recipientThreadId: threadId,
        environment: "local",
        createdAt: held.acceptedAt,
        duplicateSend: {
          hash: duplicateSendHash(threadId, "continue the follow-up"),
          senderThreadId: null,
        },
        receipt: { ...held, sendId: "z-forced" },
      }),
    );
  }
  const { RemoteEnvironmentClient } = await import("../src/client.js");
  const lookup = vi.spyOn(RemoteEnvironmentClient.prototype, "lookupSendReceipt");
  if (options.unavailable) lookup.mockRejectedValue(new Error("offline"));
  else
    lookup.mockResolvedValue({
      state: "found",
      receipts: [options.current ?? started],
      retentionDays: 30,
    });
  const send = vi
    .spyOn(RemoteEnvironmentClient.prototype, "sendMessage")
    .mockResolvedValue({ dispatched: true, queued: false, sendId: "new-send" });
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let stdout = "",
    stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    complete();
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    complete();
    return true;
  });
  process.exitCode = 0;
  process.argv = [
    process.execPath,
    "cli.ts",
    "send",
    "worker",
    " continue\n the\t follow-up ",
    ...(options.flags ?? []),
  ];
  try {
    await import("../src/cli.js");
    await finished;
    return {
      code: process.exitCode,
      stdout,
      stderr,
      sends: send.mock.calls,
      lookups: lookup.mock.calls,
    };
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

describe("send command duplicate protection", () => {
  it("refuses the released Oct 15 held original before delivering a duplicate", async () => {
    const result = await sendCommand();
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `duplicate of send original at ${held.acceptedAt} to ${threadId}; that run is running; use --force to send anyway\n`,
    );
    expect(result.stdout).toBe("");
    expect(result.sends).toHaveLength(0);
    expect(result.lookups).toEqual([[{ type: "exact", sendId: "original" }]]);
  });
  it.each([["--force"], ["--send-id", "original"], ["--coalesce", "progress"], ["--progress"]])(
    "preserves bypass/retry/keyed semantics %j",
    async (...flags) => {
      const result = await sendCommand({ flags });
      expect(result.code).toBe(0);
      expect(result.sends).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ dispatched: true, sendId: "new-send" });
    },
  );
  it("allows a freshly confirmed terminal run even though the cached receipt was held", async () => {
    const result = await sendCommand({
      current: { ...started, run: { ...started.run!, terminal: true, status: "completed" } },
    });
    expect(result.sends).toHaveLength(1);
    expect(result.code).toBe(0);
  });
  it("refuses an old held send even when the receipt read fails, explaining uncertainty", async () => {
    const result = await sendCommand({ unavailable: true });
    expect(result.code).toBe(1);
    expect(result.sends).toHaveLength(0);
    expect(result.stderr).toContain("unknown (receipt read unavailable; treated as not terminal)");
  });
  it("recovers a dropped acknowledgement through the existing lookup", async () => {
    const result = await sendCommand({ cached: false });
    expect(result.code).toBe(1);
    expect(result.sends).toHaveLength(0);
  });
});

it("preserves uncertainty when both the original acknowledgement and recovery read are unavailable", async () => {
  const result = await sendCommand({ cached: false, unavailable: true });
  expect(result.code).toBe(1);
  expect(result.sends).toHaveLength(0);
  expect(result.stderr).toContain("receipt read unavailable; treated as not terminal");
});

it("does not treat a new explicit send ID as a retry", async () => {
  const result = await sendCommand({ flags: ["--send-id", "brand-new"] });
  expect(result.code).toBe(1);
  expect(result.sends).toHaveLength(0);
});
