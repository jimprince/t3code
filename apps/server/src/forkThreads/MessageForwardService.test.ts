import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  EnvironmentId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type ChatAttachment,
  type MessageForwardAcceptInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../attachmentStore.ts";
import { makeHandoffService } from "./HandoffService.ts";
import { makeMessageForwardService } from "./MessageForwardService.ts";
import { initializeMetadata } from "./MetadataStore.ts";

const sourceId = ThreadId.make("forward-source");
const targetId = ThreadId.make("forward-target");
const text = "  Brad's exact text\r\nScreenshots: 🧬\n\tDo not summarize.  ";
const screenshot: ChatAttachment = {
  type: "image",
  id: ChatAttachmentId.make("forward-source-11111111-1111-4111-8111-111111111111"),
  name: "screen.jpeg",
  mimeType: "image/png",
  sizeBytes: 6,
};
const document: ChatAttachment = {
  type: "file",
  id: ChatAttachmentId.make("forward-source-22222222-2222-4222-8222-222222222222-pdf"),
  name: "details.pdf",
  mimeType: "application/pdf",
  sizeBytes: 4,
};
const bytes = [new Uint8Array([0, 255, 13, 10, 128, 7]), new Uint8Array([37, 80, 68, 70])];

const config = Config.layerTest(process.cwd(), { prefix: "forward-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const registry = Registry.layerFromAdapters([
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Forwarding must never call a provider"),
  },
]);
const runtime = makeOrchestratorV2ReplayLayerWithRegistry({ name: "forward" }, registry, {
  databaseLayer: SqlitePersistenceMemory,
  runEffectWorker: false,
});
const live = Threads.layer.pipe(
  Layer.provideMerge(runtime),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(config),
);
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "forward", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "forward", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const mcpLayer = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(NodeServices.layer),
);
const create = (id: ThreadId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${id}`),
  threadId: id,
  projectId: ProjectId.make("forward-project"),
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});
const run = <E>(
  test: Effect.Effect<
    void,
    E,
    | Threads.ThreadManagementService
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | Config.ServerConfig
  >,
) => Effect.scoped(test).pipe(Effect.provide(live));

const setup = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const cfg = yield* Config.ServerConfig;
  yield* initializeMetadata(sql);
  yield* threads.dispatch(create(sourceId));
  yield* threads.dispatch(create(targetId));
  for (const [index, attachment] of [screenshot, document].entries())
    yield* fs.writeFile(
      resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment })!,
      bytes[index]!,
    );
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("source-human"),
    threadId: sourceId,
    messageId: MessageId.make("original"),
    text,
    attachments: [screenshot, document],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("source-agent"),
    threadId: sourceId,
    messageId: MessageId.make("agent-note"),
    text: "newer agent handoff",
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  });
  const handoffs = makeHandoffService(sql, threads, Effect.succeed([]), "authenticated-forwarder");
  const forwards = makeMessageForwardService(sql, threads, handoffs.accept);
  const bundle = yield* forwards.prepare({ threadId: sourceId, selection: { type: "last-user" } });
  const input: MessageForwardAcceptInput = {
    sendId: "forward-1",
    recipientThreadId: targetId,
    senderThreadId: sourceId,
    sourceUrl: "https://t3.example/environment/forward-source?messageId=original",
    senderName: "Chief of Staff",
    note: "Route to the owner.",
    bundle,
    coalesceKey: null,
    intent: "auto",
  };
  return { threads, fs, cfg, forwards, handoffs, input };
});

it.effect(
  "forwards the human message with byte-exact image/file attachments, attribution and native receipts without provider work",
  () =>
    run(
      Effect.gen(function* () {
        const { forwards, handoffs, input, threads, fs, cfg } = yield* setup;
        expect(input.bundle.sourceMessageId).toBe("original");
        expect(input.bundle.text).toBe(text);
        const receipt = yield* forwards.accept(input);
        expect(receipt.status).toBe("started");
        const records = yield* threads.getThreadRecords(targetId, ["messages"]);
        expect(records.messages).toHaveLength(1);
        const message = records.messages[0]!;
        expect(message.text).toBe(
          `From Brad via Chief of Staff, ${input.sourceUrl}\nRouting note: Route to the owner.\n\n${text}`,
        );
        expect(message.senderThreadId).toBe(sourceId);
        expect(message.attachments).toHaveLength(2);
        for (const [index, attachment] of message.attachments.entries()) {
          expect(attachment.id.startsWith("forward-target-")).toBe(true);
          expect(attachment.name).toBe(input.bundle.attachments[index]!.name);
          expect(
            resolveAttachmentPathById({
              attachmentsDir: cfg.attachmentsDir,
              attachmentId: attachment.id,
            }),
          ).toBe(resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment }));
          const copied = yield* fs.readFile(
            resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment })!,
          );
          expect(Array.from(copied)).toEqual(Array.from(bytes[index]!));
        }
        // A lost ack is resolved by its receipt. An exact explicit retry adds no message.
        expect(
          (yield* handoffs.lookup({ type: "exact", sendId: "forward-1" })).receipts[0]?.status,
        ).toBe("started");
        yield* forwards.accept(input);
        expect((yield* threads.getThreadRecords(targetId, ["messages"])).messages).toHaveLength(1);
        const source = yield* threads.getThreadRecords(sourceId, ["messages"]);
        expect(source.messages.find((item) => item.id === "original")?.text).toBe(text);
      }),
    ),
);

it.effect(
  "holds settled forwards and preserves every attachment on an explicit retry after unsettle",
  () =>
    run(
      Effect.gen(function* () {
        const { forwards, input, threads, handoffs, fs, cfg } = yield* setup;
        yield* threads.dispatch({
          type: "thread.settle",
          threadId: targetId,
          commandId: CommandId.make("settle"),
        });
        const held = yield* forwards.accept(input);
        expect(held.status).toBe("held");
        expect((yield* threads.getThreadRecords(targetId, ["messages"])).messages).toHaveLength(0);
        yield* threads.dispatch({
          type: "thread.unsettle",
          threadId: targetId,
          commandId: CommandId.make("unsettle"),
          reason: "user",
        });
        yield* fs.remove(
          resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment: screenshot })!,
        );
        yield* fs.remove(
          resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment: document })!,
        );
        expect(
          (yield* handoffs.accept({
            sendId: input.sendId,
            recipientThreadId: targetId,
            senderThreadId: sourceId,
            text: held.forwardedMessage.text,
            attachments: held.forwardedMessage.attachments,
            coalesceKey: null,
            intent: "auto",
          })).status,
        ).toBe("started");
        expect(
          (yield* threads.getThreadRecords(targetId, ["messages"])).messages[0]?.attachments,
        ).toHaveLength(2);
      }),
    ),
);

it.effect(
  "rejects missing/malformed attachment bytes and changed same-id payloads without partial messages",
  () =>
    run(
      Effect.gen(function* () {
        const { forwards, input, threads } = yield* setup;
        const missing = yield* Effect.result(forwards.accept({ ...input, stagedAttachments: [] }));
        expect(missing._tag).toBe("Failure");
        const malformed = yield* Effect.result(
          forwards.accept({
            ...input,
            stagedAttachments: input.bundle.attachments.map((item) => ({
              ...item,
              id: ChatAttachmentId.make("pending-33333333-3333-4333-8333-333333333333"),
            })),
          }),
        );
        expect(malformed._tag).toBe("Failure");
        expect((yield* threads.getThreadRecords(targetId, ["messages"])).messages).toHaveLength(0);
        yield* forwards.accept(input);
        expect(
          (yield* Effect.result(forwards.accept({ ...input, note: "changed routing" })))._tag,
        ).toBe("Failure");
        expect((yield* threads.getThreadRecords(targetId, ["messages"])).messages).toHaveLength(1);
      }),
    ),
);

it.effect(
  "prepares the exact selected message and refuses to silently drop a missing source file",
  () =>
    run(
      Effect.gen(function* () {
        const { forwards, fs, cfg } = yield* setup;
        const agent = yield* forwards.prepare({
          threadId: sourceId,
          selection: { type: "message", messageId: MessageId.make("agent-note") },
        });
        expect(agent.author).toBe("agent");
        expect(agent.text).toBe("newer agent handoff");
        yield* fs.remove(
          resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment: document })!,
        );
        expect(
          (yield* Effect.result(
            forwards.prepare({ threadId: sourceId, selection: { type: "last-user" } }),
          ))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect(
  "accepts a remote bundle only with every matching pending upload and copies all bytes into target-owned references",
  () =>
    run(
      Effect.gen(function* () {
        const { forwards, input, threads, fs, cfg } = yield* setup;
        const stagedAttachments = input.bundle.attachments.map((attachment, index) => ({
          ...attachment,
          id: ChatAttachmentId.make(
            `pending-${index === 0 ? "33333333" : "44444444"}-3333-4333-8333-333333333333${attachment.type === "file" ? "-pdf" : ""}`,
          ),
        }));
        for (const [index, attachment] of stagedAttachments.entries()) {
          yield* fs.writeFile(
            resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment })!,
            bytes[index]!,
          );
          yield* fs.remove(
            resolveAttachmentPath({
              attachmentsDir: cfg.attachmentsDir,
              attachment: input.bundle.attachments[index]!,
            })!,
          );
        }
        const receipt = yield* forwards.accept({
          ...input,
          bundle: { ...input.bundle, sourceThreadId: ThreadId.make("remote-source") },
          stagedAttachments,
        });
        expect(receipt.status).toBe("started");
        const records = yield* threads.getThreadRecords(targetId, ["messages"]);
        expect(records.messages).toHaveLength(1);
        expect(records.messages[0]!.text.endsWith(text)).toBe(true);
        expect(records.messages[0]!.attachments).toHaveLength(2);
        for (const [index, attachment] of records.messages[0]!.attachments.entries()) {
          expect(attachment.id.startsWith("forward-target-")).toBe(true);
          expect(
            Array.from(
              yield* fs.readFile(
                resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment })!,
              ),
            ),
          ).toEqual(Array.from(bytes[index]!));
        }
      }),
    ),
);

it.effect(
  "forwards through production MCP registration locally and directs remote targets to the CLI with a typed refusal",
  () =>
    run(
      Effect.gen(function* () {
        const { input, threads } = yield* setup;
        const server = yield* McpServer.McpServer;
        const scope = {
          environmentId: EnvironmentId.make("forward-env"),
          requestNamespace: "forward-mcp-session",
          thread: {
            threadId: sourceId,
            providerSessionId: "forward-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration"] as const),
        };
        const invoke = (arguments_: Record<string, unknown>) =>
          server
            .callTool({ name: "t3_thread_forward", arguments: arguments_ })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
            );
        const parameters = {
          targetThreadId: targetId,
          sourceThreadId: sourceId,
          selection: { type: "last-user" },
          sourceUrl: input.sourceUrl,
          clientRequestId: "mcp-forward",
          note: input.note,
        };
        const remote = yield* invoke({ ...parameters, targetEnvironmentId: "other-environment" });
        expect(remote.isError).toBe(true);
        const remoteText = remote.content[0];
        expect(remoteText?.type).toBe("text");
        expect(remoteText?.type === "text" ? JSON.parse(remoteText.text) : undefined).toMatchObject(
          {
            _tag: "OrchestratorMcpFailure",
            code: "cross_environment_forward_unsupported",
            message: expect.stringContaining("t3-thread forward"),
          },
        );
        expect((yield* threads.getThreadRecords(targetId, ["messages"])).messages).toHaveLength(0);
        const local = yield* invoke(parameters);
        expect(local.structuredContent).toMatchObject({ status: "started" });
        const messages = (yield* threads.getThreadRecords(targetId, ["messages"])).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]!.text).toBe(
          `From Brad via forward-source, ${input.sourceUrl}\nRouting note: ${input.note}\n\n${text}`,
        );
        expect(messages[0]!.attachments).toHaveLength(2);
      }).pipe(Effect.provide(mcpLayer)),
    ),
);
