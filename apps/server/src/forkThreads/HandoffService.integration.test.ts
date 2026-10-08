import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  HandoffReceipt,
  type HandoffAcceptInput,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type {
  ProviderAdapterV2,
  ProviderAdapterV2Event,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderThreadId, ProviderTurnId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { initializeMetadata, writeMetadata } from "./MetadataStore.ts";
import { makeHandoffService } from "./HandoffService.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClientReceipt = Schema.decodeUnknownEffect(
  Schema.Struct({ dispatched: Schema.Boolean, receipt: Schema.optional(HandoffReceipt) }),
);

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
// The production fixtures are private; CI and machines without them skip these explicitly.
const itFixture = fixtures ? it.effect : it.effect.skip;
const fixtureRuntime = <A, E>(
  test: Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | ThreadManagement.ThreadManagementService
    | Orchestrator.OrchestratorV2
    | EffectWorker.OrchestrationEffectWorkerV2
    | FileSystem.FileSystem
    | Scope.Scope
  >,
  adapter?: ProviderAdapterV2["Service"],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!fixtures)
        return yield* Effect.die(new Error("T3_LIFECYCLE_FIXTURES is required for handoff tests"));
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-fixture-" });
      yield* fs.copyFile(
        `${fixtures}/synthetic-edges.small.sanitized.sqlite`,
        `${directory}/state.sqlite`,
      );
      const database = makeSqlitePersistenceLive(`${directory}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "handoff" },
        ProviderAdapterRegistry.layerFromAdapters([
          adapter ?? {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: () =>
              Effect.die("Fixture acceptance must finish before any provider work"),
          },
        ]),
        { databaseLayer: database, runEffectWorker: false },
      );
      const layer = ThreadManagement.layer.pipe(
        Layer.provideMerge(runtime),
        Layer.provideMerge(database),
      );
      return yield* test.pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const create = (id: string) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`handoff:create:${id}`),
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("handoff:project"),
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});
const input = (sendId: string, recipient = "handoff:recipient"): HandoffAcceptInput => ({
  sendId,
  recipientThreadId: ThreadId.make(recipient),
  text: "sensitive-body-sentinel",
  coalesceKey: "progress",
  intent: "auto",
});

itFixture(
  "accepts before provider work, resolves a dropped ack, binds retries and redacts lookup",
  () =>
    fixtureRuntime(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* initializeMetadata(sql);
        yield* threads.dispatch(create("handoff:recipient"));
        const service = makeHandoffService(
          sql,
          threads,
          Effect.succeed([]),
          "authenticated-sender",
        );
        // Deliberately discard the first response: the caller's persisted send ID is its recovery key.
        yield* service.accept(input("ack-lost"));
        const found = yield* service.lookup({ type: "exact", sendId: "ack-lost" });
        assert.equal(found.state, "found");
        assert.equal(found.receipts[0]?.status, "started");
        assert.notInclude(yield* encodeJson(found), "sensitive-body-sentinel");
        assert.notInclude(yield* encodeJson(found), "authenticated-sender");
        const inbox = yield* intruderInbox(sql, threads);
        assert.equal(inbox.receipts[0]?.sendId, "ack-lost");
        assert.notInclude(yield* encodeJson(inbox), "sentinel");
        yield* service.accept(input("ack-lost"));
        assert.equal(
          (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["messages"]))
            .messages.length,
          1,
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(service.accept({ ...input("ack-lost"), text: "changed" })),
          ),
        );
        const intruder = makeHandoffService(sql, threads, Effect.succeed([]), "other-sender");
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(intruder.lookup({ type: "exact", sendId: "ack-lost" })),
          ),
        );
        assert.equal(
          (yield* service.lookup({ type: "exact", sendId: "never-sent" })).state,
          "unknown",
        );
      }),
    ),
);

itFixture("rolls back the authenticated receipt with a failed native acceptance transaction", () =>
  fixtureRuntime(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* initializeMetadata(sql);
      yield* threads.dispatch(create("handoff:recipient"));
      const service = makeHandoffService(sql, threads, Effect.succeed([]), "sender");
      yield* sql`CREATE TRIGGER fail_handoff_commit BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(ABORT,'private transaction sentinel'); END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.accept(input("rolled-back")))));
      assert.equal(
        (yield* service.lookup({ type: "exact", sendId: "rolled-back" })).state,
        "unknown",
      );
      assert.equal(
        (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["messages"])).messages
          .length,
        0,
      );
      yield* sql`DROP TRIGGER fail_handoff_commit`;
      assert.equal((yield* service.accept(input("healthy-after-rollback"))).status, "started");
    }),
  ),
);

itFixture(
  "holds settled workers, refuses confirmed quota exhaustion with an owner, preserves useful idle delivery",
  () =>
    fixtureRuntime(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* initializeMetadata(sql);
        yield* threads.dispatch(create("owner"));
        yield* threads.dispatch(create("handoff:recipient"));
        yield* writeMetadata(sql, {
          threadId: ThreadId.make("handoff:recipient"),
          parentThreadId: ThreadId.make("owner"),
        });
        yield* threads.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle"),
          threadId: ThreadId.make("handoff:recipient"),
        });
        const service = makeHandoffService(sql, threads, Effect.succeed([]), "sender");
        const held = yield* service.accept(input("held"));
        assert.equal(held.status, "held");
        assert.equal(held.cause, "SETTLED");
        assert.equal(
          (yield* service.accept({ ...input("settled-control"), intent: "control" })).status,
          "held",
        );
        assert.equal(
          (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["messages"]))
            .messages.length,
          0,
        );
        yield* threads.dispatch({
          type: "thread.unsettle",
          reason: "user",
          commandId: CommandId.make("unsettle"),
          threadId: ThreadId.make("handoff:recipient"),
        });
        const quota = makeHandoffService(
          sql,
          threads,
          Effect.succeed([
            {
              instanceId: "codex",
              usageLimits: { windows: [{ usedPercent: 100 }] },
            } as unknown as ServerProvider,
          ]),
          "sender",
        );
        const refused = yield* quota.accept(input("quota"));
        assert.equal(refused.cause, "QUOTA_EXHAUSTED");
        assert.equal(refused.ownerThreadId, "owner");
        assert.equal(
          (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["messages"]))
            .messages.length,
          0,
        );
        assert.equal((yield* service.accept(input("healthy"))).status, "started");
      }),
    ),
);

itFixture(
  "coalesces only the sender's queued progress, records supersession and reports multiple matches",
  () =>
    fixtureRuntime(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* initializeMetadata(sql);
        yield* threads.dispatch(create("handoff:recipient"));
        const service = makeHandoffService(sql, threads, Effect.succeed([]), "sender");
        yield* service.accept(input("first"));
        assert.equal((yield* service.accept(input("progress-old"))).status, "queued");
        assert.equal((yield* service.accept(input("progress-new"))).status, "queued");
        assert.equal(
          (yield* service.lookup({ type: "exact", sendId: "progress-old" })).receipts[0]?.status,
          "superseded",
        );
        const runs = (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["runs"]))
          .runs;
        assert.equal(runs.filter((run) => run.status === "queued").length, 1);
        yield* service.accept(input("progress-new"));
        assert.equal(
          (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), [
            "runs",
          ])).runs.filter((run) => run.status === "queued").length,
          1,
        );
        const receipt = (yield* service.lookup({ type: "exact", sendId: "progress-new" }))
          .receipts[0]!;
        assert.equal(
          (yield* service.lookup({
            type: "coalesce",
            recipientThreadId: ThreadId.make("handoff:recipient"),
            coalesceKey: "progress",
            since: receipt.acceptedAt.slice(0, 10) + "T00:00:00.000Z",
            until: receipt.acceptedAt.slice(0, 10) + "T23:59:59.999Z",
          })).state,
          "multiple",
        );
      }),
    ),
);

itFixture(
  "routes the production CLI send into a running Codex turn exactly once before provider work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("handoff-cli-running");
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        let steerCalls = 0,
          interruptCalls = 0;
        const instanceId = ProviderInstanceId.make("codex");
        const driver = ProviderDriverKind.make("codex");
        const adapter: ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: "fixture",
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`native:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: "fixture", strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`native:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: { driver, nativeId: "fixture-turn", strength: "strong" },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  }).pipe(Effect.asVoid),
                steerTurn: () =>
                  Effect.sync(() => {
                    steerCalls++;
                  }),
                interruptTurn: () =>
                  Effect.sync(() => {
                    interruptCalls++;
                  }),
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        yield* fixtureRuntime(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const threads = yield* ThreadManagement.ThreadManagementService;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* initializeMetadata(sql);
            yield* threads.dispatch({ ...create("handoff:recipient"), worktreePath: cwd });
            const service = makeHandoffService(sql, threads, Effect.succeed([]), "sender");
            const running = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "provider-turn.updated" && event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* service.accept(input("first-running"));
            yield* worker.drain();
            yield* Fiber.join(running);
            const fs = yield* FileSystem.FileSystem;
            const state = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-cli-state-" });
            const previous = process.env.T3_AGENT_STATE_FILE;
            process.env.T3_AGENT_STATE_FILE = `${state}/routing.json`;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (previous === undefined) delete process.env.T3_AGENT_STATE_FILE;
                else process.env.T3_AGENT_STATE_FILE = previous;
              }),
            );
            const environment = {
              name: "fixture",
              httpBaseUrl: "http://fixture.invalid",
              wsBaseUrl: "ws://fixture.invalid",
              environmentId: "fixture",
              label: "fixture",
              serverVersion: "fixture",
              bearerToken: "fixture",
              expiresAt: "2099-01-01T00:00:00Z",
              pairedAt: "2026-10-07T00:00:00Z",
            };
            const requests = yield* Queue.unbounded<{
              input: HandoffAcceptInput;
              resolve: (value: HandoffReceipt) => void;
              reject: (error: unknown) => void;
            }>();
            yield* Effect.forever(
              Queue.take(requests).pipe(
                Effect.flatMap((request) =>
                  service
                    .accept(request.input)
                    .pipe(Effect.match({ onSuccess: request.resolve, onFailure: request.reject })),
                ),
              ),
            ).pipe(Effect.forkScoped);
            const rpc = {
              request: (_method: string, input: HandoffAcceptInput) =>
                new Promise<HandoffReceipt>((resolve, reject) => {
                  if (!Queue.offerUnsafe(requests, { input, resolve, reject }))
                    reject(new Error("TRANSPORT_ERROR"));
                }),
              dispose: async () => undefined,
            };
            // Separate TS projects have different compiler policies. Runtime import
            // exercises the production CLI without compiling it as server source.
            const cliModule = new URL("../../../t3-thread/src/client.ts", import.meta.url).href;
            const { RemoteEnvironmentClient } = yield* Effect.promise(() => import(cliModule));
            const client = new RemoteEnvironmentClient(environment, {
              descriptorFactory: async () => ({
                environmentId: "fixture",
                label: "fixture",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "fixture",
                orchestrationProtocolVersion: 2,
                capabilities: { reliableHandoffs: true },
              }),
              rpcFactory: () => rpc as any,
            });
            const send = {
              commandId: "cli-running",
              threadId: "handoff:recipient",
              text: "steer fixture",
            };
            const receipt = yield* Effect.promise(() => client.sendMessage(send)).pipe(
              Effect.flatMap(decodeClientReceipt),
            );
            assert.isTrue(receipt.dispatched);
            assert.equal(receipt.receipt?.status, "steered");
            assert.equal(steerCalls, 0);
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            assert.equal(interruptCalls, 0);
            yield* Effect.promise(() => client.sendMessage(send));
            yield* worker.drain();
            assert.equal(steerCalls, 1);
          }),
          adapter,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const intruderInbox = (
  sql: SqlClient.SqlClient,
  threads: ThreadManagement.ThreadManagementServiceShape,
) =>
  makeHandoffService(sql, threads, Effect.succeed([]), "read-authorized-owner").inbox(
    ThreadId.make("handoff:recipient"),
  );

itFixture(
  "refuses archived recipients and opt-out busy sends without losing healthy dispatch",
  () =>
    fixtureRuntime(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* initializeMetadata(sql);
        yield* threads.dispatch(create("handoff:recipient"));
        const service = makeHandoffService(sql, threads, Effect.succeed([]), "sender");
        assert.equal((yield* service.accept(input("idle"))).status, "started");
        assert.equal(
          (yield* service.accept({ ...input("no-queue"), allowQueueFallback: false })).cause,
          "BUSY",
        );
        assert.equal(
          (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["messages"]))
            .messages.length,
          1,
        );
        yield* threads.dispatch(create("archived"));
        yield* threads.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive"),
          threadId: ThreadId.make("archived"),
        });
        assert.equal((yield* service.accept(input("archived-send", "archived"))).cause, "ARCHIVED");
      }),
    ),
);

itFixture("preserves other sender provenance while coalescing queued handoffs", () =>
  fixtureRuntime(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* initializeMetadata(sql);
      yield* threads.dispatch(create("handoff:recipient"));
      yield* threads.dispatch(create("sender-a"));
      yield* threads.dispatch(create("sender-b"));
      const service = makeHandoffService(
        sql,
        threads,
        Effect.succeed([]),
        "shared-authenticated-user",
      );
      yield* service.accept(input("first"));
      yield* service.accept({
        ...input("sender-a-old"),
        senderThreadId: ThreadId.make("sender-a"),
      });
      yield* service.accept({ ...input("sender-b"), senderThreadId: ThreadId.make("sender-b") });
      yield* service.accept({
        ...input("sender-a-new"),
        senderThreadId: ThreadId.make("sender-a"),
      });
      assert.equal(
        (yield* service.lookup({ type: "exact", sendId: "sender-a-old" })).receipts[0]?.status,
        "superseded",
      );
      assert.equal(
        (yield* service.lookup({ type: "exact", sendId: "sender-b" })).receipts[0]?.status,
        "queued",
      );
      assert.equal(
        (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["runs"])).runs.filter(
          (run) => run.status === "queued",
        ).length,
        2,
      );
    }),
  ),
);

itFixture(
  "reports bounded inbox/coalesce truncation and expires lookup without forgetting the ID binding",
  () =>
    fixtureRuntime(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* initializeMetadata(sql);
        yield* threads.dispatch(create("handoff:recipient"));
        const service = makeHandoffService(sql, threads, Effect.succeed([]), "sender");
        for (let index = 0; index < 51; index++) yield* service.accept(input(`bounded:${index}`));
        const inbox = yield* service.inbox(ThreadId.make("handoff:recipient"));
        assert.equal(inbox.receipts.length, 50);
        assert.isTrue(inbox.truncated);
        const date = inbox.receipts[0]!.acceptedAt.slice(0, 10);
        const lookup = yield* service.lookup({
          type: "coalesce",
          recipientThreadId: ThreadId.make("handoff:recipient"),
          coalesceKey: "progress",
          since: `${date}T00:00:00.000Z`,
          until: `${date}T23:59:59.999Z`,
        });
        assert.equal(lookup.state, "multiple");
        assert.equal(lookup.receipts.length, 50);
        assert.isTrue(lookup.truncated);
        yield* sql`UPDATE fork_thread_metadata_receipts SET payload=json_set(payload,'$.receipt.acceptedAt','1900-01-01T00:00:00.000Z') WHERE command_id='handoff:bounded:0'`;
        assert.equal(
          (yield* service.lookup({ type: "exact", sendId: "bounded:0" })).state,
          "unknown",
        );
        yield* service.accept(input("bounded:0"));
        assert.equal(
          (yield* threads.getThreadRecords(ThreadId.make("handoff:recipient"), ["messages"]))
            .messages.length,
          51,
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.accept({ ...input("bounded:0"), text: "different payload" }),
            ),
          ),
        );
      }),
    ),
);
