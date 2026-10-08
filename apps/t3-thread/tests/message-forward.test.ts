import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  ThreadId,
  MessageId,
  ChatAttachmentId,
  type MessageForwardBundle,
} from "@t3tools/contracts";
import { RemoteEnvironmentClient } from "../src/client.js";
import { drainQueuedSends } from "../src/sendQueue.js";
import { loadState, saveState } from "../src/state.js";
import { descriptorFixture } from "./descriptor-fixture.js";
import type { SavedEnvironment } from "../src/types.js";

const environment: SavedEnvironment = {
  name: "forward-fixture",
  httpBaseUrl: "http://fixture.invalid",
  wsBaseUrl: "ws://fixture.invalid",
  environmentId: "forward-fixture",
  label: "Forward fixture",
  serverVersion: "fixture",
  bearerToken: "fixture",
  expiresAt: "2099-01-01T00:00:00Z",
  pairedAt: "2026-10-08T00:00:00Z",
};
const bundle: MessageForwardBundle = {
  sourceThreadId: ThreadId.make("source"),
  sourceMessageId: MessageId.make("message"),
  sourceProjectId: "project",
  sourceTitle: "Chief",
  author: "user",
  text: " exact\r\n🧬  ",
  attachments: [
    {
      type: "image",
      id: ChatAttachmentId.make("source-11111111-1111-4111-8111-111111111111"),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    },
  ],
};
const forward = {
  bundle,
  sourceUrl: "https://source.example/environment/source?messageId=message",
  senderName: "Chief",
  note: "owner",
};

it("reads from the source RPC and transports portable bytes to the target RPC without reading host paths", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "forward-client-"));
  const old = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
  const sourceRequest = vi.fn(async (method: string) =>
    method === "fork.message.forward.prepare"
      ? bundle
      : { relativeUrl: "/assets/signed-source", expiresAt: 1 },
  );
  const source = new RemoteEnvironmentClient(
    { ...environment, name: "source-host" },
    {
      rpcFactory: () => ({ request: sourceRequest, dispose: async () => undefined }) as any,
    },
  );
  const request = vi.fn(async (method: string, input: any) => {
    if (method === "attachments.createUploadUrl")
      return {
        attachmentId: "pending-33333333-3333-4333-8333-333333333333",
        relativeUrl: "/uploads/signed-target",
        expiresAt: 1,
      };
    expect(method).toBe("fork.message.forward.accept");
    expect(input.bundle).toEqual(bundle);
    expect(input.note).toBe("owner");
    expect(input.stagedAttachments[0].id).toBe("pending-33333333-3333-4333-8333-333333333333");
    return {
      sendId: input.sendId,
      recipientThreadId: input.recipientThreadId,
      status: "started",
      cause: null,
      ownerThreadId: null,
      acceptedAt: "2026-10-08T00:00:00Z",
    };
  });
  const target = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      capabilities: { reliableHandoffs: true },
    }),
    rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
  });
  const uploaded: Uint8Array[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        uploaded.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
        return new Response("{}", { status: 200 });
      }
      return new Response(new Uint8Array([0, 255, 128]), { status: 200 });
    }),
  );
  try {
    expect(
      await source.prepareForward({
        threadId: bundle.sourceThreadId,
        selection: { type: "message", messageId: bundle.sourceMessageId },
      }),
    ).toEqual(bundle);
    expect(sourceRequest).toHaveBeenCalledWith("fork.message.forward.prepare", {
      threadId: "source",
      selection: { type: "message", messageId: "message" },
    });
    const stagedAttachments = await source.stageForwardAttachments(bundle, target);
    expect(uploaded).toEqual([new Uint8Array([0, 255, 128])]);
    expect(
      await target.sendMessage({
        threadId: "target",
        text: bundle.text,
        forward: { ...forward, stagedAttachments },
        commandId: "portable-send",
      }),
    ).toMatchObject({ dispatched: true, receipt: { status: "started" } });
    expect(request).toHaveBeenCalledTimes(2);
    const intent = await NodeFSP.readFile(
      NodePath.join(directory, "send-intents", "portable-send.json"),
      "utf8",
    );
    expect(intent).not.toContain("contentBase64");
    expect(intent).not.toContain("screen.png");
  } finally {
    vi.unstubAllGlobals();
    if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = old;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("keeps staged attachment references in a settled send queue and replays the same forwarding payload", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "forward-held-"));
  const old = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
  const forwardedMessage = {
    text: `From Brad via Chief, ${forward.sourceUrl}\n\n${bundle.text}`,
    attachments: bundle.attachments.map((item) => ({
      ...item,
      id: ChatAttachmentId.make("target-44444444-4444-4444-8444-444444444444"),
    })),
  };
  const request = vi.fn(async (_method: string, input: any) => ({
    forwardedMessage,
    sendId: input.sendId,
    recipientThreadId: input.recipientThreadId,
    status: "held",
    cause: "SETTLED",
    ownerThreadId: null,
    acceptedAt: "2026-10-08T00:00:00Z",
  }));
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      capabilities: { reliableHandoffs: true },
    }),
    rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
  });
  try {
    await saveState({
      version: 1,
      environments: [environment],
      agents: [],
      subscriptions: [],
      notifications: [],
      queuedSends: [],
    });
    const outcome = await client.sendMessage({
      threadId: "target",
      text: bundle.text,
      forward,
      commandId: "held-forward",
    });
    expect(outcome).toMatchObject({ queued: true, receipt: { status: "held" } });
    expect(outcome.receipt).not.toHaveProperty("forwardedMessage");
    const state = await loadState();
    expect(state.queuedSends[0]?.forward).toEqual(forward);
    expect(state.queuedSends[0]?.forwardedMessage).toEqual(forwardedMessage);
    // Readback of the exact queue row is the durable receipt, with no timed waits.
    expect(state.queuedSends[0]?.serverSendId).toBe("held-forward");
    const sendMessage = vi.fn(async () => ({ dispatched: true, queued: false }));
    await drainQueuedSends({
      clientFactory: () => ({
        supportsReliableHandoffs: async () => true,
        findThread: async () =>
          ({
            id: "target",
            settledOverride: null,
            archivedAt: null,
            latestTurn: null,
            session: null,
            messages: [],
            activities: [],
          }) as any,
        sendMessage,
      }),
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "held-forward", forward, forwardedMessage }),
    );
  } finally {
    if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = old;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("discards only its pending uploads and never sends after a partial attachment transfer fails", async () => {
  const sourceRequest = vi.fn(async () => ({ relativeUrl: "/assets/source", expiresAt: 1 }));
  let uploadIndex = 0;
  const targetRequest = vi.fn(async (method: string) => {
    if (method === "attachments.createUploadUrl") {
      uploadIndex++;
      return {
        relativeUrl: "/uploads/target",
        attachmentId: `pending-${uploadIndex === 1 ? "33333333" : "44444444"}-3333-4333-8333-333333333333`,
        expiresAt: 1,
      };
    }
    return undefined;
  });
  const source = new RemoteEnvironmentClient(environment, {
    rpcFactory: () => ({ request: sourceRequest, dispose: async () => undefined }) as any,
  });
  const target = new RemoteEnvironmentClient(
    { ...environment, httpBaseUrl: "http://target.invalid" },
    { rpcFactory: () => ({ request: targetRequest, dispose: async () => undefined }) as any },
  );
  let downloads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("{}", { status: 200 });
      downloads++;
      return downloads === 1
        ? new Response(new Uint8Array([0, 255, 128]))
        : new Response("missing", { status: 404 });
    }),
  );
  try {
    const two: MessageForwardBundle = {
      ...bundle,
      attachments: [
        bundle.attachments[0]!,
        {
          ...bundle.attachments[0]!,
          id: ChatAttachmentId.make("source-22222222-2222-4222-8222-222222222222"),
        },
      ],
    };
    await expect(source.stageForwardAttachments(two, target)).rejects.toThrow("Unable to download");
    expect(
      targetRequest.mock.calls.filter(([method]) => method === "attachments.delete"),
    ).toHaveLength(2);
    expect(targetRequest.mock.calls.some(([method]) => method.startsWith("fork."))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
