// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { expect, it } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

function runtime(dbPath: string, cwd: string) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
    ).pipe(
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(makeSqlitePersistenceLive(dbPath)),
      Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "t3-automation-persistence-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}

it("persists the definition and run history across restart, replay and duplicate command receipts", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-automation-persistence-"));
  const projectId = ProjectId.make("automation-project");
  const db = NodePath.join(dir, "state.sqlite");
  let system = runtime(db, dir);
  const create = {
    type: "project.automation.create" as const,
    projectId,
    commandId: CommandId.make("automation-create"),
    automation: {
      id: "daily",
      name: "Digest",
      prompt: "Review changes",
      enabled: true,
      schedule: { kind: "daily" as const, time: "09:00", timeZone: "America/Toronto" },
      target: { kind: "new-thread" as const },
    },
  };
  const run = {
    type: "project.automation.run" as const,
    projectId,
    commandId: CommandId.make("automation-run"),
    automationId: "daily",
  };
  try {
    await system.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project-create"),
          projectId,
          title: "Project",
          workspaceRoot: dir,
          createdAt: "2026-10-03T00:00:00.000Z",
        });
        yield* engine.dispatch(create);
        yield* engine.dispatch(run);
        const query = yield* ProjectionSnapshotQuery;
        const snapshot = yield* query.getShellSnapshot();
        expect(snapshot.projects[0]?.automations?.[0]?.runs).toHaveLength(1);
        expect((yield* query.getCommandReadModel()).projects[0]?.automations?.[0]?.prompt).toBe(
          "Review changes",
        );
      }),
    );
    await system.dispose();
    system = runtime(db, dir);
    await system.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch(create);
        yield* engine.dispatch(run);
        const query = yield* ProjectionSnapshotQuery;
        const stored = (yield* query.getSnapshot()).projects[0]?.automations?.[0];
        expect(stored?.name).toBe("Digest");
        expect(stored?.runs).toHaveLength(1);
        yield* engine.dispatch({
          type: "project.automation.pause",
          commandId: CommandId.make("pause"),
          projectId,
          automationId: "daily",
        });
        expect((yield* query.getShellSnapshot()).projects[0]?.automations?.[0]?.enabled).toBe(
          false,
        );
      }),
    );
  } finally {
    await system.dispose();
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
