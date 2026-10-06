import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AutomationRun,
  type AutomationRunStep,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  NodeId,
  type OrchestrationV2StoredEvent,
  type ThreadPullRequestLink,
  type AutomationEventKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ApplicationEvents from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Settings from "../serverSettings.ts";
import { NodeServices } from "@effect/platform-node";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
const issuesTestContext = Layer.mergeAll(
  NodeServices.layer,
  Layer.mock(ProjectService.ProjectService)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "automation-gateway-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  FetchHttpClient.layer,
);
import { AgentGateway, layer as gatewayLayer } from "./AgentGateway.ts";
import { listMetadata } from "../forkThreads/MetadataStore.ts";

// Issues are a separate lane; this test exercises the native launch/record boundary only.
vi.mock("../projectIssues/ProjectIssuesService.ts", async () => {
  const Effect = await import("effect/Effect");
  return { make: Effect.succeed({ list: () => Effect.succeed({ issues: [] }) }) };
});
const projectId = ProjectId.make("automation-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "automation-gateway" },
  Registry.makeLayer([
    {
      instanceId: modelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("No external provider execution in gateway tests"),
    },
  ]),
  { databaseLayer: database, runEffectWorker: false },
);
const nativeLayer = Layer.mergeAll(
  ThreadManagement.layer.pipe(Layer.provide(runtime)),
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(Layer.provideMerge(database));
const step: AutomationRunStep = {
  kind: "agent",
  status: "queued",
  target: { kind: "existing-thread", threadId: ThreadId.make("target") },
  threadId: ThreadId.make("target"),
  messageId: MessageId.make("automation:input"),
  title: "Review",
  prompt: "Review changes",
  result: null,
  startedAt: null,
  finishedAt: null,
};
const run: AutomationRun = {
  id: "run",
  automationId: "review",
  projectId,
  name: "Review",
  dedupeKey: "slot",
  trigger: { kind: "manual" },
  dryRun: false,
  status: "queued",
  result: null,
  steps: [step],
  createdAt: "2026-10-06T00:00:00Z",
  finishedAt: null,
};
const create = (id: ThreadId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${id}`),
  threadId: id,
  projectId,
  title: id,
  modelSelection,
  createdBy: "system" as const,
  creationSource: "server" as const,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
});

it.effect(
  "dispatches an exact input once, waits for its native root, and retains busy or missing-input outcomes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Automation','/tmp/automation','[]','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z')`;
      yield* threads.dispatch(create(step.threadId));
      const launches: ThreadLaunch.ThreadLaunchInput[] = [];
      const layer = gatewayLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(SqlClient.SqlClient, sql),
            Layer.succeed(ThreadManagement.ThreadManagementService, threads),
            Layer.succeed(ProjectStore.ProjectStoreV2, yield* ProjectStore.ProjectStoreV2),
            Settings.layerTest(),
            Layer.mock(ApplicationEvents.OrchestrationEventStore)({}),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              launch: (input) =>
                Effect.gen(function* () {
                  launches.push(input);
                  yield* threads
                    .dispatch({
                      type: "message.dispatch",
                      commandId: input.commandId,
                      threadId: input.threadId!,
                      messageId: input.initialMessage!.messageId!,
                      text: input.initialMessage!.text,
                      attachments: [],
                      createdBy: "system",
                      creationSource: "server",
                      dispatchMode: { type: "defer_start" },
                    })
                    .pipe(Effect.orDie);
                  return {
                    threadId: input.threadId!,
                    projection: yield* threads
                      .getThreadProjection(input.threadId!)
                      .pipe(Effect.orDie),
                    resumed: true,
                  };
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const gateway = yield* AgentGateway;
        const first = yield* gateway.advance(run, step);
        assert.equal(first.status, "running");
        assert.equal((yield* gateway.advance(run, step)).status, "running");
        const records = yield* threads.getThreadRecords(step.threadId, ["runs", "messages"]);
        assert.equal(records.messages.filter((message) => message.id === step.messageId).length, 1);
        assert.equal(records.runs.length, 1);
        const other = { ...step, messageId: MessageId.make("automation:other") };
        assert.equal((yield* gateway.advance(run, other)).status, "queued");
        assert.equal(
          (yield* gateway.advance(run, { ...other, status: "running" })).result,
          "Run message is unavailable.",
        );
        // A restart after thread creation but before input admission resumes the native launch path.
        const partial = {
          ...step,
          target: { kind: "new-thread" as const },
          threadId: ThreadId.make("partial"),
          messageId: MessageId.make("automation:partial"),
        };
        yield* threads.dispatch(create(partial.threadId));
        assert.equal((yield* gateway.advance(run, partial)).status, "running");
        assert.equal((yield* gateway.advance(run, partial)).status, "running");
        assert.equal(launches.length, 1);
        assert.equal(launches[0]?.reuseExistingThread, true);
        const ownerThreadId = ThreadId.make("automation-owner");
        yield* threads.dispatch(create(ownerThreadId));
        const fresh = {
          ...partial,
          threadId: ThreadId.make("fresh"),
          messageId: MessageId.make("automation:fresh"),
        };
        const ownedRun = { ...run, ownerThreadId };
        assert.equal((yield* gateway.advance(ownedRun, fresh)).status, "running");
        assert.equal((yield* gateway.advance(ownedRun, fresh)).status, "running");
        assert.equal(launches.length, 2);
        assert.equal(launches[1]?.reuseExistingThread, true);
        assert.equal(
          (yield* listMetadata(sql)).find((row) => row.threadId === fresh.threadId)?.parentThreadId,
          ownerThreadId,
        );
        assert.equal((yield* threads.getThreadShell(fresh.threadId))?.title, fresh.title);
        const now = yield* DateTime.now;
        const providerThreadId = ProviderThreadId.make("gateway-root-provider");
        const providerSessionId = ProviderSessionId.make("gateway-stale-session");
        yield* projections.apply({
          id: EventId.make("gateway-stopped-session"),
          type: "provider-session.attached",
          threadId: step.threadId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: modelSelection.instanceId,
            status: "stopped",
            cwd: "/tmp/automation",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projections.apply({
          id: EventId.make("gateway-provider-thread"),
          type: "provider-thread.updated",
          threadId: step.threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: modelSelection.instanceId,
            providerSessionId,
            appThreadId: step.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projections.apply({
          id: EventId.make("gateway-running-root"),
          type: "run.updated",
          threadId: step.threadId,
          occurredAt: now,
          payload: { ...records.runs[0]!, providerThreadId, status: "running", startedAt: now },
        });
        // Exact V2 input/run identity wins over a session stop, even one recorded after the input.
        assert.equal((yield* gateway.advance(run, first)).status, "running");
        yield* projections.apply({
          id: EventId.make("terminal-root"),
          type: "run.updated",
          threadId: step.threadId,
          occurredAt: now,
          payload: { ...records.runs[0]!, status: "completed", completedAt: now },
        });
        assert.equal((yield* gateway.advance(run, first)).status, "completed");
        yield* projections.apply({
          id: EventId.make("failed-root"),
          type: "run.updated",
          threadId: step.threadId,
          occurredAt: now,
          payload: { ...records.runs[0]!, status: "failed", completedAt: now },
        });
        assert.equal((yield* gateway.advance(run, first)).result, "Turn error.");
        yield* threads.dispatch({
          type: "thread.archive",
          threadId: step.threadId,
          commandId: CommandId.make("archive"),
        });
        assert.equal((yield* gateway.advance(run, other)).result, "Target thread is archived.");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.merge(nativeLayer, issuesTestContext))),
);

it.effect(
  "maps only wanted native events and initializes PR observations from historical links",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* threads.dispatch(create(step.threadId));
        const thread = (yield* threads.getThreadProjection(step.threadId)).thread;
        const now = yield* DateTime.now;
        const base = {
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
        };
        const link: ThreadPullRequestLink = {
          host: "git.example.test",
          repository: "owner/repo",
          number: 1,
          url: "https://git.example.test/owner/repo/pulls/1",
          source: "manual",
          linkedAt: DateTime.formatIso(now),
          snapshot: null,
          stack: null,
        };
        const historical: OrchestrationV2StoredEvent = {
          sequence: 1,
          commandId: null,
          event: {
            ...base,
            id: EventId.make("historical"),
            type: "thread.created",
            payload: { ...thread, pullRequests: [link] },
          },
        };
        const events: OrchestrationV2StoredEvent[] = [
          {
            sequence: 2,
            commandId: null,
            event: {
              ...base,
              id: EventId.make("pr"),
              type: "thread.pull-request-synced",
              payload: { ...thread, pullRequests: [link] },
            },
          },
          {
            sequence: 3,
            commandId: null,
            event: {
              ...base,
              id: EventId.make("approval"),
              type: "runtime-request.updated",
              payload: {
                id: RuntimeRequestId.make("approval"),
                nodeId: NodeId.make("node"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "command",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
          },
          {
            sequence: 4,
            commandId: null,
            event: {
              ...base,
              id: EventId.make("session"),
              type: "provider-session.updated",
              payload: {
                id: ProviderSessionId.make("session"),
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: modelSelection.instanceId,
                status: "error",
                cwd: "/tmp",
                model: "test",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: "Failed",
              },
            },
          },
        ];
        const wanted = new Set<AutomationEventKind>();
        let replayToggle = false;
        const addedLink = { ...link, number: 2 };
        const toggledEvents: OrchestrationV2StoredEvent[] = [
          events[0]!,
          {
            sequence: 3,
            commandId: null,
            event: {
              ...base,
              id: EventId.make("disabled-pr"),
              type: "thread.pull-request-synced",
              payload: { ...thread, pullRequests: [link, addedLink] },
            },
          },
          {
            sequence: 4,
            commandId: null,
            event: {
              ...base,
              id: EventId.make("reenabled-pr"),
              type: "thread.pull-request-synced",
              payload: { ...thread, pullRequests: [link, addedLink] },
            },
          },
        ];
        let shellReads = 0;
        let historicalReads = 0;
        const layer = gatewayLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(SqlClient.SqlClient, sql),
              Layer.succeed(ThreadManagement.ThreadManagementService, {
                ...threads,
                getThreadShell: (id) =>
                  Effect.sync(() => {
                    shellReads += 1;
                  }).pipe(Effect.andThen(threads.getThreadShell(id))),
              }),
              Layer.succeed(ProjectStore.ProjectStoreV2, yield* ProjectStore.ProjectStoreV2),
              Settings.layerTest(),
              Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
              Layer.mock(ApplicationEvents.OrchestrationEventStore)({
                latestApplicationSequence: Effect.succeed(1),
                streamApplicationEvents: () =>
                  Stream.fromIterable(replayToggle ? toggledEvents : events).pipe(
                    Stream.tap((stored) =>
                      Effect.sync(() => {
                        if (replayToggle) {
                          wanted.clear();
                          if (stored.sequence !== 3) wanted.add("pull-request.opened");
                        }
                      }),
                    ),
                  ),
                readAgentEvents: (input) => {
                  historicalReads += 1;
                  if (replayToggle && input!.throughSequence === 3)
                    return Stream.fromIterable(
                      input!.eventType === "thread.pull-request-synced"
                        ? [toggledEvents[1]!]
                        : [historical],
                    );
                  assert.equal(input!.throughSequence, 1);
                  return Stream.fromIterable(
                    input!.eventType === "thread.created" ? [historical] : [],
                  );
                },
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const gateway = yield* AgentGateway;
          assert.deepEqual(
            yield* (yield* gateway.observations(() => wanted)).pipe(Stream.runCollect),
            [],
          );
          assert.equal(shellReads, 0);
          wanted.add("worker.blocked");
          const seen = yield* (yield* gateway.observations(() => wanted)).pipe(Stream.runCollect);
          assert.deepEqual(
            seen.map((item) => item.type),
            ["thread-waiting", "thread-session"],
          );
          assert.equal(shellReads, 2);
          assert.equal(historicalReads, 0);
          wanted.clear();
          wanted.add("pull-request.opened");
          assert.deepEqual(
            yield* (yield* gateway.observations(() => wanted)).pipe(Stream.runCollect),
            [],
          );
          assert.equal(shellReads, 3);
          assert.equal(historicalReads, 2);
          replayToggle = true;
          shellReads = 0;
          historicalReads = 0;
          // Disabling a listener performs no reads; re-enabling must not replay old additions.
          assert.deepEqual(
            yield* (yield* gateway.observations(() => wanted)).pipe(Stream.runCollect),
            [],
          );
          assert.equal(shellReads, 2);
          assert.equal(historicalReads, 4);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(Layer.merge(nativeLayer, issuesTestContext))),
);
