import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
const require = NodeModule.createRequire(import.meta.url);
const socketRequire = NodeModule.createRequire(require.resolve("@effect/platform-node/NodeSocket"));
const { WebSocketServer } = socketRequire("ws");
const jsonMode = process.argv[3] === "threads";
const metrics = { connections: 0, shellReads: 0, archiveReads: 0, queueReads: [], refreshes: 0 };
// Publish the complete metrics receipt before replying to concurrent RPCs.
const record = () => NodeFS.writeFileSync(`${process.argv[2]}.metrics`, JSON.stringify(metrics));
const at = "2026-10-05T00:00:00.000Z";
const thread = (id) => ({
  id,
  projectId: "project",
  title: "Worker",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: id, relationshipToParent: "subagent", rootThreadId: id },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
});
const agents = Array.from({ length: jsonMode ? 3 : 48 }, (_, i) => ({
  name: `worker-${i}`,
  environment: "fixture",
  threadId: `worker-${i}`,
  projectId: "project",
  title: "Worker",
  createdAt: at,
  lastSeenAssistantMessageId: null,
}));
const server = NodeHttp.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.includes("refresh")) {
    metrics.refreshes++;
    void record();
    res.statusCode = 500;
    res.end("{}");
    return;
  }
  if (req.url === "/api/auth/websocket-ticket")
    res.end(JSON.stringify({ ticket: "fixture", expiresAt: at }));
  else
    res.end(
      JSON.stringify({
        environmentId: "fixture",
        label: "Fixture",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "fixture",
        orchestrationProtocolVersion: 2,
        capabilities: { sessionRefresh: jsonMode },
      }),
    );
});
const ws = new WebSocketServer({ server });
ws.on("connection", (socket) => {
  metrics.connections++;
  void record();
  socket.on("message", (data) => {
    for (const call of String(data)
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s))) {
      if (call._tag === "Ping") {
        socket.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      if (call._tag !== "Request") continue;
      if (call.tag === "orchestration.getArchivedShellSnapshot" && jsonMode) {
        metrics.archiveReads++;
        void record();
        const archived = {
          ...thread("archived"),
          archivedAt: at,
          latestRunId: null,
          activeRunId: null,
          status: "idle",
          pendingRuntimeRequest: null,
          latestVisibleMessage: null,
          latestUserMessageAt: null,
          hasActionableProposedPlan: false,
          itemCount: 0,
          visibleItemCount: 0,
        };
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: call.id,
            exit: {
              _tag: "Success",
              value: { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [archived] },
            },
          }),
        );
        continue;
      }
      if (call.tag === "orchestration.subscribeShell" && jsonMode) {
        metrics.shellReads++;
        void record();
        const threads = agents.map((agent, i) => ({
          ...thread(agent.threadId),
          latestRunId: null,
          activeRunId: i === 0 ? "active" : null,
          latestRunStartedAt: i === 0 ? at : null,
          status: i === 0 ? "running" : "idle",
          pendingRuntimeRequest: null,
          latestVisibleMessage: null,
          latestUserMessageAt: null,
          hasActionableProposedPlan: false,
          itemCount: 0,
          visibleItemCount: 0,
        }));
        socket.send(
          JSON.stringify({
            _tag: "Chunk",
            requestId: call.id,
            values: [
              {
                kind: "snapshot",
                snapshot: {
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  projects: [],
                  threads,
                  archivedThreads: [],
                },
              },
            ],
          }),
        );
        continue;
      }
      if (
        call.tag !== "orchestration.subscribeThread" &&
        !(jsonMode && call.tag === "orchestration.getThreadProjection")
      )
        throw new Error(`Unexpected RPC ${call.tag}`);
      if (jsonMode) {
        metrics.queueReads.push(call.payload.threadId);
        void record();
        if (call.payload.threadId === "worker-1") continue; // Cancellation/timeout regression.
      }
      const id = call.payload.threadId;
      const messages = Array.from({ length: jsonMode ? 0 : 20000 }, (_, i) => ({
        id: `${id}-${i}`,
        threadId: id,
        runId: null,
        createdBy: "user",
        creationSource: "web",
        nodeId: null,
        streaming: false,
        role: "assistant",
        text: `Message ${i} ${id}`,
        attachments: [],
        createdAt: at,
        updatedAt: at,
      }));
      const projection = {
        thread: thread(id),
        runs: [],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        messages,
        plans: [],
        turnItems: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: at,
      };
      if (jsonMode) {
        if (id === "worker-0")
          projection.runs = [false, true].map((queueHeld, i) => ({
            id: `queued-${i}`,
            threadId: id,
            ordinal: i + 1,
            providerInstanceId: "codex",
            modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
            providerThreadId: null,
            userMessageId: `prompt-${i}`,
            rootNodeId: null,
            activeAttemptId: null,
            status: "queued",
            requestedAt: at,
            startedAt: null,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            queueHeld,
          }));
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: call.id,
            exit: { _tag: "Success", value: projection },
          }),
        );
        continue;
      }
      socket.send(
        JSON.stringify({
          _tag: "Chunk",
          requestId: call.id,
          values: [{ kind: "snapshot", snapshotSequence: 1, projection }],
        }),
      );
    }
  });
});
server.listen(0, "127.0.0.1");
await NodeEvents.once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
await NodeFSP.writeFile(
  process.argv[2],
  JSON.stringify({
    version: 1,
    environments: [
      {
        name: "fixture",
        httpBaseUrl: url,
        wsBaseUrl: url.replace("http:", "ws:"),
        environmentId: "fixture",
        label: "fixture",
        serverVersion: "fixture",
        bearerToken: "fixture",
        expiresAt: jsonMode ? new Date(Date.now() + 60_000).toISOString() : "2099-01-01",
        pairedAt: at,
      },
    ],
    agents,
    subscriptions: [],
    notifications: [],
    queuedSends: jsonMode
      ? [
          {
            id: "waiting-local-send",
            status: "queued",
            sequence: 1,
            environment: "fixture",
            threadId: "worker-0",
            queuedAt: at,
          },
        ]
      : [],
  }),
);
process.stdout.write("ready\n");
