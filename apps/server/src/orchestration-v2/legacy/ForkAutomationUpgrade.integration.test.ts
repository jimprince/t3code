import { assertFixtureMigration16 } from "../../persistence/fixtureMigration16.testkit.ts";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { NodeServices } from "@effect/platform-node";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ProjectAutomation,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerConfig from "../../config.ts";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ApplicationEvents from "../../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as ThreadLaunch from "../ThreadLaunchService.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import * as LegacyImporter from "./LegacyV1ThreadImporter.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Settings from "../../serverSettings.ts";
import { AgentGateway, layer as gatewayLayer } from "../../automations/AgentGateway.ts";
import { AutomationEngine, layer as engineLayer } from "../../automations/AutomationEngine.ts";
import { layer as storeLayer } from "../../automations/AutomationStore.ts";
import { ReleaseFeed } from "../../automations/ReleaseFeed.ts";

vi.mock("../../projectIssues/ProjectIssuesService.ts", async () => {
  const Effect = await import("effect/Effect");
  return { make: Effect.succeed({ list: () => Effect.succeed({ issues: [] }) }) };
});
const encodeLegacyAutomations = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ProjectAutomation)),
);
const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
it.effect.skipIf(!fixtures)(
  "fails a copied V1 running step once at upgrade without redispatch or historical writes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: process.env.T3_AUTOMATION_TEST_TMP,
          prefix: "running-cutover-",
        });
        const copy = path.join(temporary, "state.sqlite");
        yield* fs.copyFile(path.join(fixtures!, "synthetic-edges.small.sanitized.sqlite"), copy);
        const database = NodeSqliteClient.layer({ filename: copy });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* assertFixtureMigration16;
          // Repair only this disposable sanitized copy's invalid provider identifiers.
          yield* sql`UPDATE projection_projects SET default_model_selection_json=json_set(default_model_selection_json,'$.instanceId','codex') WHERE default_model_selection_json IS NOT NULL`;
          const projectId = ProjectId.make("upgrade-project");
          const threadId = ThreadId.make("automation:upgrade");
          const messageId = MessageId.make("automation:upgrade-input");
          const at = "2026-10-06T00:00:00Z";
          const automation: ProjectAutomation = {
            id: "upgrade-active",
            name: "Review",
            enabled: false,
            prompt: "Review",
            schedule: { kind: "daily", time: "07:00", timeZone: "UTC" },
            target: { kind: "new-thread" },
            nextRunAt: "2026-10-07T07:00:00Z",
            runs: [
              {
                id: "upgrade-run",
                name: "Review",
                target: { kind: "new-thread" },
                scheduledAt: at,
                startedAt: at,
                finishedAt: null,
                threadId,
                messageId,
                prompt: "Review",
                status: "running",
                result: null,
              },
            ],
          };
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,automations_json,created_at,updated_at) VALUES (${projectId},'Upgrade','/tmp/upgrade','[]',${yield* encodeLegacyAutomations([automation])},${at},${at})`;
          yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,latest_turn_id,created_at,updated_at) VALUES (${threadId},${projectId},'Review','{"instanceId":"codex","model":"test"}','full-access','default','upgrade-turn',${at},${at})`;
          yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at) VALUES (${messageId},${threadId},'upgrade-turn','user','Review',0,${at},${at})`;
          yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES (${threadId},'upgrade-turn','running',${at},'[]')`;
          const historical = yield* sql`SELECT * FROM projection_turns WHERE thread_id=${threadId}`;
          const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
          const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "upgrade-gateway" },
            Registry.makeLayer([
              {
                instanceId: modelSelection.instanceId,
                driver: ProviderDriverKind.make("codex"),
                getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
                planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
                openSession: () => Effect.die("Upgrade must never execute a provider"),
              },
            ]),
            { databaseLayer: database, runEffectWorker: false },
          );
          const importerLayer = LegacyImporter.layer.pipe(
            Layer.provide(runtime),
            Layer.provide(database),
          );
          const threadsLayer = ThreadManagement.layerWithLegacyImporter.pipe(
            Layer.provide(Layer.merge(runtime, importerLayer)),
          );
          const native = Layer.mergeAll(
            threadsLayer,
            ProjectionStore.layer,
            ProjectStore.layer,
            importerLayer,
          ).pipe(Layer.provide(database));
          yield* Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            yield* threads.dispatch({
              type: "thread.create",
              commandId: CommandId.make("upgrade-native-shell"),
              threadId,
              projectId,
              title: "Review",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "system",
              creationSource: "server",
            });
            const shell = (yield* threads.getThreadProjection(threadId)).thread;
            yield* projections.apply({
              id: EventId.make("upgrade-origin"),
              type: "thread.created",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...shell, historyOrigin: "v1_import" },
            });
            yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, transcript_imported_at) VALUES (${threadId},${at},${at},NULL)`;
            const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
            yield* importer.ensureTranscript(threadId);
            let dispatches = 0;
            const passes = yield* Queue.unbounded<void>();
            const baseGateway = gatewayLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SqlClient.SqlClient, sql),
                  Layer.succeed(ThreadManagement.ThreadManagementService, {
                    ...threads,
                    dispatch: (input) => {
                      dispatches += 1;
                      return threads.dispatch(input);
                    },
                  }),
                  Layer.succeed(ProjectStore.ProjectStoreV2, yield* ProjectStore.ProjectStoreV2),
                  Settings.layerTest(),
                  Layer.mock(ApplicationEvents.OrchestrationEventStore)({}),
                  Layer.mock(ThreadLaunch.ThreadLaunchService)({
                    launch: () => Effect.die("Upgrade must never launch"),
                  }),
                ),
              ),
            );
            const observedGateway = Layer.effect(
              AgentGateway,
              Effect.gen(function* () {
                const gateway = yield* AgentGateway;
                return AgentGateway.of({
                  ...gateway,
                  legacyAutomations: gateway.legacyAutomations.pipe(
                    Effect.tap(() => Queue.offer(passes, undefined)),
                  ),
                  wakeups: () => Effect.succeed(Stream.never),
                  observations: () => Effect.succeed(Stream.never),
                });
              }),
            ).pipe(Layer.provide(baseGateway));
            const engineServices = Layer.mergeAll(
              storeLayer,
              observedGateway,
              Layer.mock(ReleaseFeed)({}),
            ).pipe(Layer.provide(database));
            yield* Effect.gen(function* () {
              const engine = yield* AutomationEngine;
              yield* engine.start();
              yield* Queue.take(passes);
              yield* engine.drain;
              const first = yield* engine.runs({ automationId: automation.id });
              assert.equal(first.length, 1);
              assert.equal(first[0]?.status, "failed");
              assert.equal(
                first[0]?.steps[0]?.result,
                "Interrupted by the upgrade. Run it again if needed.",
              );
              yield* importer.ensureTranscript(threadId);
              // Saving this imported disabled rule requests a second completed import pass.
              const imported = (yield* engine.list(projectId)).find(
                (item) => item.id === automation.id,
              )!;
              yield* engine.save(imported);
              yield* Queue.take(passes);
              yield* engine.drain;
              assert.deepEqual(yield* engine.runs({ automationId: automation.id }), first);
              assert.equal(dispatches, 0);
              assert.deepEqual(
                yield* sql`SELECT * FROM projection_turns WHERE thread_id=${threadId}`,
                historical,
              );
            }).pipe(Effect.provide(engineLayer.pipe(Layer.provide(engineServices))));
          }).pipe(Effect.provide(native));
        }).pipe(Effect.provide(database));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ProjectService.ProjectService)({}),
          ServerConfig.layerTest(process.cwd(), { prefix: "automation-gateway-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          FetchHttpClient.layer,
        ),
      ),
    ),
);
