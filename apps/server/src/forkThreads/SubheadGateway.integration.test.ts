import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  ProviderInstanceId,
  ServerProvider,
  type Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, vi } from "vite-plus/test";
import { AgentGateway, layer as gatewayLayer } from "../automations/AgentGateway.ts";
import { AutomationStore } from "../automations/AutomationStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectService from "../project/ProjectService.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as SetupScripts from "../project/ProjectSetupScriptRunner.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Text from "../textGeneration/TextGeneration.ts";
import * as TaskIssues from "../projectIssues/TaskIssueLaunchService.ts";
import * as Settings from "../serverSettings.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as ProviderMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerConfig from "../config.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { makeSubheadRegistry } from "./SubheadRegistry.ts";
import { makeSubheadRuns } from "./SubheadRuns.ts";
import { readMetadata } from "./MetadataStore.ts";
import {
  subheadNativeLayer,
  subheadProject,
  createSubheadTestThread,
} from "./SubheadNative.testkit.ts";

// Issue polling is unrelated to native launch and would require an external Gitea account.
vi.mock("../projectIssues/ProjectIssuesService.ts", async () => {
  const Effect = await import("effect/Effect");
  return { make: Effect.succeed({ list: () => Effect.succeed({ issues: [] }) }) };
});
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "fixture",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00.000Z",
  models: [],
});

it.layer(NodeServices.layer)("native virtual launch", (it) => {
  it.effect(
    "pins model/runtime and retries after a lost engine write without another thread or message",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "subhead-launch-" });
        const at = "2026-10-15T00:00:00.000Z";
        const project: Project = {
          id: subheadProject,
          title: "Fixture",
          workspaceRoot,
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        };
        const external = Layer.mergeAll(
          FetchHttpClient.layer,
          ServerConfig.layerTest(workspaceRoot, { prefix: "subhead-gateway-" }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some(project)),
          }),
          SetupTracker.layer,
          Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
          Layer.mock(Terminals.TerminalManager)({ close: () => Effect.void }),
          Layer.mock(Git.GitWorkflowService)({}),
          Layer.mock(SetupScripts.ProjectSetupScriptRunner)({
            runForThread: () => Effect.die("No setup script"),
          }),
          Layer.mock(Text.TextGeneration)({}),
          Layer.mock(TaskIssues.TaskIssueLaunchService)({}),
          Layer.mock(Folders.ManagedProjectFolders)({
            namedProjectsRoot: "/unused",
            folderForThread: () => Effect.succeed(Option.none()),
          }),
          Settings.layerTest(),
          ProviderMock.layer([provider]),
          Layer.mock(Events.OrchestrationEventStore)({}),
        );
        const launch = Launch.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              external,
              subheadNativeLayer,
              Receipts.layer.pipe(Layer.provide(subheadNativeLayer)),
              IdAllocator.layer,
            ),
          ),
        );
        const gateway = gatewayLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              external,
              launch,
              subheadNativeLayer,
              Projects.layer.pipe(Layer.provide(subheadNativeLayer)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${subheadProject},'Fixture',${workspaceRoot},'[]',${at},${at})`;
          const head = ThreadId.make("head");
          yield* createSubheadTestThread(head);
          const registry = yield* makeSubheadRegistry;
          const selected = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "fixture-pinned-model",
          };
          const template = {
            name: "review",
            projectId: subheadProject,
            ownerThreadId: head,
            description: "Review",
            prompt: "Frozen prompt",
            modelSelection: selected,
            runtimeMode: "approval-required" as const,
            concurrency: 1,
          };
          yield* registry.create(template);
          yield* registry.setState("review", "enable");
          const admission = yield* makeSubheadRuns;
          const run = yield* admission.send(
            {
              environmentId: "environment",
              principal: "script:test",
              threadId: null,
              runtimeMode: "full-access",
            },
            { name: "review", requestId: "same", request: "Review" },
          );
          const live = yield* AgentGateway;
          const first = yield* live.advance(run, run.steps[0]!);
          expect(
            first.status,
            Option.getOrThrow(yield* (yield* AutomationStore).getRun(run.id)).virtualSubhead
              ?.blockedReason ?? undefined,
          ).toBe("running");
          // Replay the persisted queued step, as after a crash before the engine's progress write.
          const retry = yield* live.advance(run, run.steps[0]!);
          expect(retry.status).toBe("running");
          const execution = run.steps[0]!.threadId;
          const threads = yield* Threads.ThreadManagementService;
          const shell = yield* threads.getThreadShell(execution);
          expect(shell?.modelSelection).toEqual(selected);
          expect(shell?.runtimeMode).toBe("approval-required");
          expect(yield* readMetadata(sql, execution)).toMatchObject({
            parentThreadId: head,
            virtualAgentId: run.virtualSubhead!.agentId,
            virtualRunId: run.id,
          });
          expect(
            (yield* threads.getThreadRecords(execution, ["messages"])).messages.filter(
              (message) => message.role === "user",
            ),
          ).toHaveLength(1);
          const native = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;
          expect(native[0]?.count).toBe(2);
          expect(
            Option.getOrThrow(yield* (yield* AutomationStore).getRun(run.id)).virtualSubhead
              ?.template.prompt,
          ).toBe("Frozen prompt");
          yield* registry.create({ ...template, name: "review-timeout" });
          yield* registry.setState("review-timeout", "enable");
          const pending = yield* admission.send(
            {
              environmentId: "environment",
              principal: "script:test",
              threadId: null,
              runtimeMode: "full-access",
            },
            {
              name: "review-timeout",
              requestId: "expired-empty-claim",
              request: "Must not start after its lease expires",
            },
          );
          const expired = {
            ...pending,
            status: "running" as const,
            virtualSubhead: {
              ...pending.virtualSubhead!,
              leaseStartedAt: DateTime.formatIso(
                DateTime.subtract(yield* DateTime.now, { minutes: 31 }),
              ),
            },
          };
          const store = yield* AutomationStore;
          yield* store.saveRun(expired);
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make("expired-empty-claim"),
            threadId: expired.steps[0]!.threadId,
            projectId: subheadProject,
            title: "Interrupted launch",
            modelSelection: selected,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "system",
            creationSource: "server",
          });
          const outcome = yield* live.advance(expired, expired.steps[0]!);
          expect(outcome.status).toBe("failed");
          expect(outcome.result).toContain("timeout");
          expect(
            (yield* threads.getThreadRecords(expired.steps[0]!.threadId, ["messages"])).messages,
          ).toHaveLength(0);
        }).pipe(Effect.provide(Layer.mergeAll(gateway, subheadNativeLayer)));
      }),
  );
});
