import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CommandId, DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";
import { expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentGateway from "./AgentGateway.ts";
import * as AutomationEngine from "./AutomationEngine.ts";
import * as AutomationStore from "./AutomationStore.ts";
import * as ReleaseFeed from "./ReleaseFeed.ts";

function runtimeLayer(dbPath: string, cwd: string) {
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  );
  return AutomationEngine.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(AgentGateway.layer, AutomationStore.layer, ReleaseFeed.layer),
    ),
    Layer.provideMerge(orchestration),
    Layer.provide(
      Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) }),
    ),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "t3-automation-gateway-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(FetchHttpClient.layer),
  );
}

it.layer(NodeServices.layer)("automation gateway on the V1 core", (it) => {
  it.effect(
    "copies an automation created the original way once and leaves the original in place",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-automation-gateway-" });
          const projectId = ProjectId.make("automation-project");
          const db = (yield* Path.Path).join(dir, "state.sqlite");
          yield* Effect.gen(function* () {
            const orchestration = yield* OrchestrationEngineService;
            yield* orchestration.dispatch({
              type: "project.create",
              commandId: CommandId.make("project-create"),
              projectId,
              title: "Project",
              workspaceRoot: dir,
              createdAt: "2026-10-05T00:00:00.000Z",
            });
            yield* orchestration.dispatch({
              type: "project.automation.create",
              projectId,
              commandId: CommandId.make("legacy-create"),
              automation: {
                id: "nightly",
                name: "Nightly review",
                prompt: "Review the fork",
                enabled: true,
                schedule: { kind: "daily", time: "03:00", timeZone: "America/Edmonton" },
                target: { kind: "new-thread" },
              },
            });
            const query = yield* ProjectionSnapshotQuery;
            const legacy = (yield* query.getProjectShells())[0]?.automations?.[0];
            expect(legacy?.nextRunAt).toBeDefined();

            const automations = yield* AutomationEngine.AutomationEngine;
            yield* automations.start();
            // Saving enqueues a pass after it commits; drain waits for that pass and its import.
            const manual = {
              id: "manual",
              projectId,
              name: "Manual",
              enabled: true,
              triggers: [],
              actions: [
                { type: "agent" as const, prompt: "Go", target: { kind: "new-thread" as const } },
              ],
            };
            yield* automations.save(manual);
            yield* automations.drain;
            yield* automations.save({ ...manual, name: "Manual again" });
            yield* automations.drain;

            const imported = yield* automations.list(projectId);
            expect(new Set(imported.map((automation) => automation.id))).toEqual(
              new Set(["nightly", "manual"]),
            );
            expect(imported.find((automation) => automation.id === "nightly")).toMatchObject({
              nextRunAt: legacy?.nextRunAt,
              actions: [{ type: "agent", prompt: "Review the fork" }],
            });
            // The original stays on the project for a rollback.
            expect((yield* query.getProjectShells())[0]?.automations).toEqual([legacy]);
          }).pipe(Effect.provide(runtimeLayer(db, dir)));
        }),
      ),
  );
});
