import { NamedAgentName, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const NOW = "2026-10-03T00:00:00.000Z";

it.effect("keeps a named agent across a restart: stored, then read back for the decider", () => {
  const layer = Layer.mergeAll(
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionProjectRepositoryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return Effect.gen(function* () {
    const projects = yield* ProjectionProjectRepository;
    const query = yield* ProjectionSnapshotQuery;
    const base = {
      kind: "workspace" as const,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    yield* projects.upsert({
      ...base,
      projectId: ProjectId.make("printer"),
      title: "printer",
      workspaceRoot: "/agents/printer",
      permanentAgent: { name: NamedAgentName.make("printer") },
    });
    yield* projects.upsert({
      ...base,
      projectId: ProjectId.make("plain"),
      title: "plain",
      workspaceRoot: "/plain",
    });

    const readModel = yield* query.getCommandReadModel();
    const shell = yield* query.getShellSnapshot();
    const agentOf = (
      entries: ReadonlyArray<{ id: string; permanentAgent?: unknown }>,
      id: string,
    ) => entries.find((entry) => entry.id === id)?.permanentAgent;

    assert.deepEqual(agentOf(readModel.projects, "printer"), { name: "printer" });
    assert.deepEqual(agentOf(shell.projects, "printer"), { name: "printer" });
    assert.isUndefined(agentOf(readModel.projects, "plain"));
  }).pipe(Effect.provide(layer));
});
