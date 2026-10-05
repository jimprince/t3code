import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

const workspacePathsLayer = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const metadataLayer = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (workspaceRoot) =>
      Effect.succeed({
        canonicalKey: `github.com/t3tools/${workspaceRoot.split("/").at(-1)}`,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: `git@github.com:t3tools/${workspaceRoot.split("/").at(-1)}.git`,
        },
        rootPath: workspaceRoot,
      }),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
  }),
);

const makeTestLayer = (
  projectMetadataLayer: Layer.Layer<
    | ProjectFaviconResolver.ProjectFaviconResolver
    | RepositoryIdentityResolver.RepositoryIdentityResolver
  >,
) =>
  ProjectServiceLayerLive.pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(workspacePathsLayer),
    Layer.provideMerge(projectMetadataLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const TestLayer = makeTestLayer(metadataLayer);

import { ensureGeneralChat, getChatProjectId } from "./GeneralChatService.ts";
import { initializeProjectKinds } from "./ProjectKinds.ts";
import migration036 from "../persistence/Migrations/036_ProjectionProjectsKind.ts";
import migration037 from "../persistence/Migrations/037_UniqueProjectCreation.ts";

it.effect("concurrent startup and restart preserve one General Chat beside Scratch", () =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const ids = yield* Effect.all(
      [ensureGeneralChat("environment-chat"), ensureGeneralChat("environment-chat")],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(ids, [
      getChatProjectId("environment-chat"),
      getChatProjectId("environment-chat"),
    ]);
    assert.equal(yield* ensureGeneralChat("environment-chat"), ids[0]);
    const scratch = yield* projects.create({
      commandId: CommandId.make("scratch-create"),
      projectId: ProjectId.make("scratch"),
      title: "Scratch",
      workspaceRoot: "/tmp/scratch",
    });
    assert.equal(scratch.kind, "workspace");
    const shells = yield* projects.listShells();
    assert.equal(shells.filter((project) => project.kind === "chat").length, 1);
    const chat = shells.find((project) => project.kind === "chat")!;
    assert.equal(chat.repositoryIdentity, null);
    assert.equal(chat.id, ids[0]);
    const sql = yield* SqlClient.SqlClient;
    const events = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM orchestration_events WHERE stream_id = ${chat.id} AND event_type = 'project.created'`;
    assert.equal(events[0]?.count, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("chat project identity and workspace guards apply through the V2 service", () =>
  Effect.gen(function* () {
    const id = yield* ensureGeneralChat("guard-environment");
    const projects = yield* ProjectService.ProjectService;
    for (const update of [
      { title: "Hijacked" },
      { workspaceRoot: "/tmp/elsewhere" },
      { scripts: [] },
      { defaultModelSelection: null },
    ]) {
      const result = yield* Effect.result(
        projects.update({
          commandId: CommandId.make(`guard-${Object.keys(update)[0]}`),
          projectId: id,
          ...update,
        }),
      );
      assert.equal(Result.isFailure(result), true);
    }
    assert.equal(
      Result.isFailure(
        yield* Effect.result(
          projects.delete({ commandId: CommandId.make("delete-chat"), projectId: id, force: true }),
        ),
      ),
      true,
    );
    const unchanged = yield* projects.update({
      commandId: CommandId.make("chat-undefined-metadata"),
      projectId: id,
      title: undefined,
      workspaceRoot: undefined,
      scripts: undefined,
      defaultModelSelection: undefined,
    });
    assert.equal(unchanged.id, id);
    assert.equal(Option.isSome(yield* projects.getShell(id)), true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "036/037 kind import is idempotent and preserves original IDs through store restart",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("original-chat-id");
      yield* projects.create({
        commandId: CommandId.make("legacy-create"),
        projectId,
        title: "Chat",
        workspaceRoot: "/tmp/original-chat",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* migration036;
      yield* migration037;
      yield* sql`UPDATE projection_projects SET kind = 'chat' WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM fork_project_kinds WHERE project_id = ${projectId}`;
      yield* initializeProjectKinds(sql);
      yield* initializeProjectKinds(sql);
      const restarted = yield* ProjectStore.make;
      const shell = yield* restarted.getShell(projectId);
      assert.equal(Option.isSome(shell) && shell.value.kind, "chat");
      assert.equal(Option.isSome(shell) && shell.value.id, projectId);
      const records = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM fork_project_kinds WHERE project_id = ${projectId}`;
      assert.equal(records[0]?.count, 1);
    }).pipe(Effect.provide(TestLayer)),
);
