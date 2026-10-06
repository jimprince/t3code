import { drainQueuedSends } from "../src/sendQueue.js";
import { loadState, saveState } from "../src/state.js";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { RemoteEnvironmentClient } from "../src/client.js";
import { resolvePairingTarget, resolveWebSocketUrl } from "../src/http.js";
import { Schema } from "effect";
import { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import { decodeThreadSnapshotItem } from "../src/contracts.js";
import { T3RpcClient } from "../src/rpc.js";

it("pairs with an isolated V2 server, launches a custom instance, reads and controls its run", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-v2-"));
  const home = NodePath.join(directory, "t3");
  const repo = NodePath.join(directory, "workspace");
  const state = NodePath.join(directory, "operator-state.json");
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  await NodeFSP.mkdir(repo);
  NodeChildProcess.execFileSync("git", ["init", "-q", repo]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  const peer = NodeURL.fileURLToPath(
    new URL("../../server/src/provider/testFixtures/codexCollabMockPeer.mjs", import.meta.url),
  );
  const capture = JSON.parse(
    await NodeFSP.readFile(
      NodeURL.fileURLToPath(
        new URL("../../server/src/provider/testFixtures/codexMultiAgentWire.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  const script = NodePath.join(directory, "peer.json");
  await NodeFSP.writeFile(
    script,
    JSON.stringify({
      rootThreadId: capture.rootThreadId,
      notifications: [],
      holdTurnOpen: true,
      serverRequests: [
        {
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "${threadId}",
            turnId: "${turnId}",
            itemId: "approval-fixture",
            kind: "command",
            startedAtMs: 1790000000000,
            environmentId: "local",
            command: "echo fixture",
            cwd: repo,
            commandActions: [],
            availableDecisions: ["accept", "decline", "cancel"],
          },
        },
        {
          method: "item/tool/requestUserInput",
          params: {
            threadId: "${threadId}",
            turnId: "${turnId}",
            itemId: "input-fixture",
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Choose?",
                isOther: true,
                isSecret: false,
                options: [{ label: "Yes", description: "Continue" }],
              },
            ],
            isBlocking: true,
            autoResolutionMs: null,
          },
        },
      ],
    }),
  );
  const wrapper = NodePath.join(directory, "mock-codex");
  await NodeFSP.writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.145.0'; exit 0; fi\nprintf '%s\\n' "$T3_THREAD_ID" >> '${directory}/identity'\nexec '${process.execPath}' '${peer}'\n`,
    { mode: 0o755 },
  );
  await NodeFSP.writeFile(
    NodePath.join(home, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        cli_custom: {
          driver: "codex",
          enabled: true,
          config: {
            setupMode: "existing",
            binaryPath: wrapper,
            homePath: NodePath.join(directory, "codex-home"),
          },
          environment: [{ name: "T3_CODEX_COLLAB_SCRIPT", value: script }],
        },
      },
      enableProviderUpdateChecks: false,
    }),
  );
  // All server and operator writes land in fresh temporary state.
  vi.stubEnv("T3_AGENT_STATE_FILE", state);
  const bin = NodeURL.fileURLToPath(new URL("../../server/src/bin.ts", import.meta.url));
  const reservation = NodeNet.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const port = String(address.port);
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      bin,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      port,
      "--base-dir",
      home,
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        T3CODE_DISABLE_STARTUP_RESUME: "1",
        T3CODE_DEV_AUTH_TOKEN: "",
        T3CODE_HOME: home,
        CODEX_HOME: NodePath.join(directory, "codex-home"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const sockets: T3RpcClient[] = [];
  // The Vitest deadline alone does not unwind awaited streams; close this
  // fixture's captured process so finally also runs on a missing receipt.
  const deadline = setTimeout(() => server.kill("SIGTERM"), 150_000);
  try {
    const pairingUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const receive = (chunk: Buffer) => {
        output += chunk.toString();
        const match = /Pairing URL: (\S+)/.exec(output);
        if (match) resolve(match[1]!);
      };
      server.stdout.on("data", receive);
      server.stderr.on("data", receive);
      server.once("error", reject);
      server.once("exit", (code) =>
        reject(
          new Error(
            `Isolated server exited ${code}: ${output.replace(/(?:https?|wss?):\/\/\S+/g, "<url>").slice(-3000)}`,
          ),
        ),
      );
    });

    const paired = await RemoteEnvironmentClient.pair({
      name: "fixture",
      ...resolvePairingTarget({ pairingUrl }),
    });
    const operatorState = await loadState();
    await saveState({ ...operatorState, environments: [paired] });
    const client = new RemoteEnvironmentClient(paired);
    expect((await client.describe()).orchestrationProtocolVersion).toBe(2);
    const project =
      (await client.listProjects()).find((project) => project.workspaceRoot === repo) ??
      (await client.createProject({ workspaceRoot: repo, title: "Fixture", noDefaultModel: true }));
    expect(project).toBeDefined();

    const created = await client.createAgentThread({
      projectId: project.id,
      title: "CLI worker",
      provider: "cli_custom",
      model: "gpt-6.1-sol",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      initialMessage: "Hold the run open",
    });

    const detail = await client.findThread(created.threadId);
    expect(
      detail.messages.some(
        (message) => message.role === "user" && message.text === "Hold the run open",
      ),
    ).toBe(true);
    expect(detail.modelSelection.provider).toBe("cli_custom");
    expect(detail.session).toBeNull();
    const rpc = new T3RpcClient(await resolveWebSocketUrl(paired));
    sockets.push(rpc);

    await rpc.waitForThreadEvent(created.threadId, (item) => {
      if (item.kind === "snapshot" && item.projection.runs.some((run) => run.status === "failed"))
        throw new Error(JSON.stringify(item.projection.attempts));
      if (
        item.kind === "event" &&
        item.event.type === "run.updated" &&
        item.event.payload.status === "failed"
      )
        throw new Error(JSON.stringify(item.event.payload));
      return item.kind === "snapshot"
        ? item.projection.providerTurns.length > 0
        : item.kind === "event" && item.event.type === "provider-turn.updated";
    });

    await rpc.waitForThreadEvent(created.threadId, (item) => {
      return item.kind === "snapshot"
        ? item.projection.runtimeRequests.filter((request) => request.status === "pending")
            .length === 2
        : item.kind === "event" &&
            item.event.type === "runtime-request.updated" &&
            item.event.payload.kind === "user_input";
    });
    const requests = await client.pending(created.threadId);
    expect(requests).toHaveLength(2);
    vi.spyOn(client, "findThread").mockResolvedValueOnce({
      ...detail,
      runtimeRequests: [
        {
          ...requests[0]!,
          responseCapability: { type: "not_resumable", reason: "Fixture expired" },
        },
      ],
    });
    await expect(
      client.respond({
        threadId: created.threadId,
        requestId: requests[0]!.id,
        decision: "accept",
      }),
    ).rejects.toThrow("Fixture expired");
    for (const request of requests) {
      const resolved = rpc.waitForThreadEvent(created.threadId, (item) =>
        item.kind === "snapshot"
          ? item.projection.runtimeRequests.some(
              (candidate) => candidate.id === request.id && candidate.status !== "pending",
            )
          : item.kind === "event" &&
            item.event.type === "runtime-request.updated" &&
            item.event.payload.id === request.id &&
            item.event.payload.status !== "pending",
      );
      await client.respond({
        threadId: created.threadId,
        requestId: request.id,
        ...(request.kind === "user_input"
          ? { answers: { choice: { answers: ["Yes"] } } }
          : { decision: "accept" as const }),
      });
      await resolved;
    }
    expect(await client.pending(created.threadId)).toEqual([]);
    const file = {
      type: "file" as const,
      id: "file-fixture",
      name: "notes.zip",
      mimeType: "application/zip",
      sizeBytes: 10,
    };
    const projection = detail.projection!;
    const encoded = Schema.encodeSync(OrchestrationV2ThreadStreamItem)({
      kind: "snapshot",
      snapshotSequence: 1,
      projection: {
        ...projection,
        messages: projection.messages.map((message) => ({ ...message, attachments: [file] })),
      },
    });
    expect(decodeThreadSnapshotItem(encoded).snapshot.thread.messages[0]?.attachments).toEqual([
      file,
    ]);
    expect((await NodeFSP.readFile(NodePath.join(directory, "identity"), "utf8")).split("\n")).toContain(
      created.threadId,
    );
    const queued = await client.sendMessage({ threadId: created.threadId, text: "Follow-up" });
    expect(queued.queued).toBe(true);
    const sender = { source: "thread-send", fromThreadId: "sender" };
    const first = await client.sendMessage({
      threadId: created.threadId,
      text: "status 1",
      origin: sender,
      senderEnvironment: "one",
      coalesceKey: "status",
    });
    const ordinary = await client.sendMessage({
      threadId: created.threadId,
      text: "ordinary instruction",
      origin: sender,
      senderEnvironment: "one",
    });
    const foreign = await client.sendMessage({
      threadId: created.threadId,
      text: "foreign status",
      origin: sender,
      senderEnvironment: "two",
      coalesceKey: "status",
    });
    const latest = await client.sendMessage({
      threadId: created.threadId,
      text: "status 2",
      origin: sender,
      senderEnvironment: "one",
      coalesceKey: "status",
    });
    expect(first.queued && ordinary.queued && foreign.queued && latest.queued).toBe(true);
    const queuedState = await loadState();
    expect(queuedState.queuedSends.find((record) => record.text === "status 1")?.status).toBe(
      "cancelled",
    );
    expect(
      queuedState.queuedSends
        .filter((record) => record.status === "queued")
        .map((record) => record.text),
    ).toEqual(["Follow-up", "ordinary instruction", "foreign status", "status 2"]);
    expect(await client.setThreadPinned(created.threadId, true)).toMatchObject({ pinned: true });
    expect(await client.setThreadPinned(created.threadId, false)).toMatchObject({ pinned: false });
    const interrupted = rpc.waitForThreadEvent(created.threadId, (item) =>
      item.kind === "snapshot"
        ? item.projection.runs.some((run) => run.status === "interrupted")
        : item.kind === "event" &&
          item.event.type === "run.updated" &&
          item.event.payload.status === "interrupted",
    );
    await client.interrupt(created.threadId);
    await interrupted;
    const drained = await drainQueuedSends({ clientFactory: () => client });
    expect(drained[0]?.lastError).toBeNull();
    expect(drained.map((record) => [record.text, record.status])).toEqual([
      ["Follow-up", "dispatched"],
    ]);
    const delivered = rpc.waitForThreadEvent(created.threadId, (item) =>
      item.kind === "snapshot"
        ? item.projection.messages.some((message) => message.text === "Follow-up")
        : item.kind === "event" &&
          item.event.type === "message.updated" &&
          item.event.payload.text === "Follow-up",
    );
    await delivered;
    expect(
      (await client.findThread(created.threadId)).messages.some(
        (message) => message.text === "status 1",
      ),
    ).toBe(false);
    await client.interrupt(created.threadId);
    expect(await client.settleThread(created.threadId)).toMatchObject({
      settledOverride: "settled",
    });
    expect(await client.unsettleThread(created.threadId)).toMatchObject({
      settledOverride: "active",
    });
    // The integrated M2 tip advertises the real sidecar; M1 retains its explicit capability gap.
    const descriptor = await client.describe();
    expect(descriptor.capabilities.threadNesting).toBe(true);
    if (descriptor.capabilities.threadNesting === true) {
      const child = await client.createAgentThread({
        projectId: created.projectId,
        title: "Nested CLI worker",
        provider: "cli_custom",
        initialMessage: "Hold the nested run open",
        runtimeMode: "approval-required",
        parentThreadId: created.threadId,
      });
      expect(await client.findThread(child.threadId)).toMatchObject({
        parentThreadId: created.threadId,
        executionParentThreadId: null,
        session: null,
      });
      const shellRefresh = rpc.waitForThreadEvent(
        child.threadId,
        (item) => item.kind === "event" && item.event.type === "thread.metadata-updated",
      );
      await client.setThreadParent(child.threadId, null);
      await shellRefresh;
      expect(await client.findThread(child.threadId)).toMatchObject({
        parentThreadId: null,
        remoteParent: null,
      });
      await client.interrupt(child.threadId);
    }
  } finally {
    clearTimeout(deadline);
    await Promise.all(sockets.map((socket) => socket.dispose()));
    if (server.exitCode === null) server.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      server.exitCode !== null ? resolve() : server.once("exit", () => resolve()),
    );
    vi.unstubAllEnvs();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 180_000);
